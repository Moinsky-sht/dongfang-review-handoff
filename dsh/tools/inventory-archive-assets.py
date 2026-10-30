"""Technical archive inventory. No extractall, member-path writes, content roles or model calls.

ZIP: Python zipfile with actual ZipInfo/CRC reads. RAR: libarchive's public
read-only C API, sequential headers and data, through a small ctypes binding.
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import io
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import struct
import sys
import time
import uuid
import xml.etree.ElementTree as ET
import zipfile
import zlib

sys.dont_write_bytecode = True

ROOT = Path(__file__).absolute().parent.parent
RUNS = ROOT / "data/optimization/runs"
DEFAULT_DLL = Path("C:/Windows/System32/archiveint.dll")
MAX_MEMBER_BYTES = 64 * 1024 * 1024
PRIMARY_SOURCES = [
    "https://docs.python.org/3/library/zipfile.html",
    "https://www.rarlab.com/technote.htm",
    "https://github.com/libarchive/libarchive/blob/v3.8.8/libarchive/archive_read.3",
    "https://github.com/libarchive/libarchive/blob/v3.8.8/libarchive/archive_entry.3",
]
RARFILE_SOURCE_SHA = "43d4c5c8e847524c96a496ef15be29e9e7d829909be47c00887ed77d2277cc39"
RARFILE_WHEEL_SHA = "8757e1e3757e32962e229cab2432efc1f15f210823cc96ccba0f6a39d17370c9"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def absolute(path):
    return Path(os.path.abspath(path))  # Do not resolve away aliases before checking.


def within(base, target):
    try:
        return absolute(target).is_relative_to(absolute(base)) and absolute(target) != absolute(base)
    except ValueError:
        return False


def guard_ancestors(path, sealed=True):
    for item in (absolute(path), *absolute(path).parents):
        try:
            mode = item.lstat().st_mode
        except FileNotFoundError:
            mode = None
        if mode is not None:
            if stat.S_ISLNK(mode) or os.path.normcase(str(item.resolve())) != os.path.normcase(str(item)):
                raise ValueError("Output alias rejected: " + str(item))
            if not stat.S_ISDIR(mode):
                raise ValueError("Output ancestor is not a directory: " + str(item))
        if sealed and os.path.lexists(item / "complete.json"):
            raise ValueError("Sealed output ancestor rejected: " + str(item))


def checked_run(pointer):
    if not isinstance(pointer, dict) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,159}", pointer.get("runId", "")):
        raise ValueError("Invalid run pointer identity")
    value = pointer.get("runDirectory")
    if not isinstance(value, str) or not Path(value).is_absolute():
        raise ValueError("Run pointer must contain an absolute directory")
    run = absolute(value)
    if run.parent != absolute(RUNS) or run.name != pointer["runId"] or not run.is_dir():
        raise ValueError("Run pointer must identify a direct project optimizer run")
    guard_ancestors(run)
    return run


class ArtifactRoot:
    def __init__(self, run, directory):
        self.run, self.directory = absolute(run), absolute(directory)
        if not within(self.run / "artifacts", self.directory):
            raise ValueError("Archive output must be inside current unsealed run/artifacts")
        guard_ancestors(self.directory)
        if os.path.lexists(self.directory):
            raise FileExistsError("Use a fresh archive output directory")
        self.directory.parent.mkdir(parents=True, exist_ok=True)
        guard_ancestors(self.directory.parent)
        self.directory.mkdir()

    def write(self, name, data):
        target = absolute(self.directory / name)
        if not within(self.directory, target):
            raise ValueError("Artifact boundary rejected")
        guard_ancestors(target.parent)
        target.parent.mkdir(parents=True, exist_ok=True)
        guard_ancestors(target.parent)
        with target.open("xb") as stream:
            stream.write(data)
        if target.read_bytes() != data:
            raise OSError("Written artifact did not read back identically")
        return str(target.relative_to(self.directory)).replace("\\", "/")


def name_safety(name):
    normalized = name.replace("\\", "/")
    if "\x00" in name or normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
        return {"safe": False, "reason": "absolute-drive-or-NUL-member-name"}
    if any(p == ".." or ":" in p for p in normalized.split("/")):
        return {"safe": False, "reason": "traversal-or-alternate-stream-member-name"}
    return {"safe": True, "memberPathNeverUsedForOutput": True}


def zip_name(info, override=None):
    declared_utf8 = bool(info.flag_bits & 0x800)
    spec_codec = "utf-8" if declared_utf8 else "cp437"
    raw = info.orig_filename.encode(spec_codec, errors="strict")
    candidates = {spec_codec: info.orig_filename}
    try:
        candidates["utf-8"] = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        pass
    unicode_path, position = None, 0
    while position + 4 <= len(info.extra):
        tag, length = struct.unpack_from("<HH", info.extra, position)
        position += 4
        extra = info.extra[position:position + length]
        if len(extra) != length:
            raise ValueError("Truncated ZIP extra field")
        position += length
        if tag == 0x7075:
            if len(extra) < 5 or extra[0] != 1 or struct.unpack_from("<I", extra, 1)[0] != zlib.crc32(raw):
                raise ValueError("Unicode Path extra CRC/version mismatch")
            unicode_path = extra[5:].decode("utf-8", errors="strict")
    if declared_utf8 and unicode_path is not None and unicode_path != candidates["utf-8"]:
        raise ValueError("Conflicting ZIP UTF-8 declarations")
    selected_codec = spec_codec if declared_utf8 or override is None else override
    name = unicode_path if unicode_path is not None else raw.decode(selected_codec, errors="strict")
    if unicode_path is None and name.encode(selected_codec) != raw:
        raise ValueError("ZIP name codec failed exact byte round trip")
    return name, {"rawNameBytesHex": raw.hex(), "rawNameBytesSource": "ZipInfo.orig_filename round trip under ZIP's declared/fallback codec",
                  "specificationName": info.orig_filename, "utf8Flag": declared_utf8, "unicodePathExtra": unicode_path,
                  "selectedCodec": "utf-8-unicode-path-extra" if unicode_path is not None else selected_codec,
                  "explicitOverride": override if override and not declared_utf8 and unicode_path is None else None,
                  "strictCodecRoundTrip": True, "archiveDeclaredUnicode": declared_utf8 or unicode_path is not None,
                  "interpretations": candidates, "scope": "Byte codec proof; unflagged UTF-8 override is explicit, not an archive UTF-8 declaration or a semantic role."}


class LibArchive:
    API = {
        "archive_read_new": (ctypes.c_void_p, []),
        "archive_read_support_filter_all": (ctypes.c_int, [ctypes.c_void_p]),
        "archive_read_support_format_rar": (ctypes.c_int, [ctypes.c_void_p]),
        "archive_read_support_format_rar5": (ctypes.c_int, [ctypes.c_void_p]),
        "archive_read_open_memory": (ctypes.c_int, [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]),
        "archive_read_next_header": (ctypes.c_int, [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]),
        "archive_entry_pathname_utf8": (ctypes.c_char_p, [ctypes.c_void_p]),
        "archive_entry_filetype": (ctypes.c_uint, [ctypes.c_void_p]),
        "archive_entry_size": (ctypes.c_int64, [ctypes.c_void_p]),
        "archive_entry_symlink_utf8": (ctypes.c_char_p, [ctypes.c_void_p]),
        "archive_entry_hardlink_utf8": (ctypes.c_char_p, [ctypes.c_void_p]),
        "archive_read_data": (ctypes.c_ssize_t, [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]),
        "archive_read_data_skip": (ctypes.c_int, [ctypes.c_void_p]),
        "archive_error_string": (ctypes.c_char_p, [ctypes.c_void_p]),
        "archive_format_name": (ctypes.c_char_p, [ctypes.c_void_p]),
        "archive_read_close": (ctypes.c_int, [ctypes.c_void_p]),
        "archive_read_free": (ctypes.c_int, [ctypes.c_void_p]),
        "archive_version_string": (ctypes.c_char_p, []),
    }

    def __init__(self, dll=DEFAULT_DLL):
        self.path = absolute(dll)
        self.dll = ctypes.CDLL(str(self.path))
        for name, (result, arguments) in self.API.items():
            function = getattr(self.dll, name)
            function.restype, function.argtypes = result, arguments
        self.identity = {"path": str(self.path), "sha256": sha(self.path.read_bytes()),
                         "version": self.dll.archive_version_string().decode("ascii"), "binding": "Python ctypes public C ABI",
                         "apiScope": list(self.API), "readOnly": True, "archiveWriteOrExtractAPIUsed": False}

    def error(self, archive, result):
        text = self.dll.archive_error_string(archive)
        return RuntimeError("libarchive result " + str(result) + ": " + (text.decode("utf-8", errors="replace") if text else "no diagnostic"))

    def entries(self, payload, limit):
        a = self.dll.archive_read_new()
        memory = ctypes.create_string_buffer(payload)
        try:
            for name in ("archive_read_support_filter_all", "archive_read_support_format_rar", "archive_read_support_format_rar5"):
                result = getattr(self.dll, name)(a)
                if result != 0:
                    raise self.error(a, result)
            result = self.dll.archive_read_open_memory(a, memory, len(payload))
            if result != 0:
                raise self.error(a, result)
            ordinal = 0
            while True:
                entry = ctypes.c_void_p()
                result = self.dll.archive_read_next_header(a, ctypes.byref(entry))
                if result == 1:
                    break
                if result != 0:
                    raise self.error(a, result)
                raw = self.dll.archive_entry_pathname_utf8(entry)
                if raw is None:
                    raise ValueError("RAR member has no verified UTF-8 API pathname")
                name = raw.decode("utf-8", errors="strict")
                mode = self.dll.archive_entry_filetype(entry)
                size = self.dll.archive_entry_size(entry)
                link = self.dll.archive_entry_symlink_utf8(entry) or self.dll.archive_entry_hardlink_utf8(entry)
                meta = {"ordinal": ordinal, "name": name, "type": "directory" if stat.S_ISDIR(mode) else "file" if stat.S_ISREG(mode) and not link else "link-or-special",
                        "declaredBytes": size, "mode": mode, "format": self.dll.archive_format_name(a).decode("ascii", errors="replace"),
                        "nameEncoding": {"selectedCodec": "utf-8", "strictCodecRoundTrip": name.encode("utf-8") == raw,
                                         "nameBytesHex": raw.hex(), "nameBytesSource": "archive_entry_pathname_utf8: actual API-decoded pathname, not raw header bytes",
                                         "scope": "RAR5 specification uses UTF-8; no tar display decoding or filename matching."}}
                ordinal += 1
                content, error = bytearray(), None
                if meta["type"] == "directory":
                    meta["payloadVerification"] = "directory-metadata-only; payload CRC not applicable"
                    result = self.dll.archive_read_data_skip(a)
                    if result != 0:
                        raise self.error(a, result)
                elif size > limit:
                    error = ValueError("Member size exceeds configured limit")
                    result = self.dll.archive_read_data_skip(a)
                    if result != 0:
                        raise self.error(a, result)
                else:
                    buffer = ctypes.create_string_buffer(65536)
                    while True:
                        count = self.dll.archive_read_data(a, buffer, len(buffer))
                        if count < 0:
                            error = self.error(a, count)
                            break
                        if count == 0:
                            break
                        content.extend(buffer.raw[:count])
                        if len(content) > limit:
                            error = ValueError("Decoded member exceeds configured limit")
                            break
                if error is None and meta["type"] != "directory" and size >= 0 and len(content) != size:
                    error = ValueError("RAR decoded size differs from header")
                yield meta, bytes(content), error
                if error is not None:
                    # Do not claim later members were read after a decoder/CRC failure.
                    raise RuntimeError("RAR scan stopped after member " + str(meta["ordinal"]) + ": " + str(error))
        finally:
            self.dll.archive_read_close(a)
            self.dll.archive_read_free(a)


def legacy_doc_identity(data):
    if not data.startswith(bytes.fromhex("d0cf11e0a1b11ae1")):
        return None
    identity = {"kind": "ole-compound-container", "bodyParsePerformed": False, "needsConversion": True}
    if len(data) >= 512:
        shift = struct.unpack_from("<H", data, 30)[0]
        if shift in (9, 12):
            size = 1 << shift
            sector = struct.unpack_from("<I", data, 48)[0]
            offset = (sector + 1) * size
            directory = data[offset:offset + size]
            for position in range(0, len(directory) - 127, 128):
                entry = directory[position:position + 128]
                length = struct.unpack_from("<H", entry, 64)[0]
                if entry[66] == 2 and 2 <= length <= 64 and length % 2 == 0:
                    name = entry[:length - 2].decode("utf-16-le", errors="strict")
                    if name == "WordDocument":
                        identity.update(kind="legacy-doc", wordDocumentDirectoryEntry=True, directorySector=sector,
                                        scope="CFB magic and actual first-directory-sector WordDocument stream entry; no DOC text or conversion proof")
    return identity


def validate_content(data, name, limit):
    if data.startswith(b"PK"):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = archive.infolist()
            if sum(i.file_size for i in infos) > limit or any(i.file_size > limit for i in infos):
                raise ValueError("Nested ZIP/DOCX size limit exceeded")
            names = [i.filename for i in infos]
            if len(names) != len(set(names)):
                raise ValueError("Nested ZIP/DOCX duplicate member names")
            if archive.testzip() is not None:
                raise ValueError("Nested ZIP/DOCX CRC failure")
            if "[Content_Types].xml" in names and "word/document.xml" in names:
                vectors, note_ids = {}, {}
                for part in ("word/document.xml", "word/footnotes.xml", "word/endnotes.xml"):
                    if part not in names:
                        continue
                    xml = ET.fromstring(archive.read(part))
                    texts = [n.text or "" for n in xml.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t")]
                    vectors[part] = {"textNodes": len(texts), "textVectorSha256": sha(json_bytes(texts))}
                    if part != "word/document.xml":
                        note_ids[part] = [n.attrib.get("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}id") for n in xml]
                return {"kind": "docx", "status": "mechanical-readback-verified", "internalZipCrcVerified": True,
                        "parts": vectors, "noteIds": note_ids, "sourceContentJudged": False}
            if name.lower().endswith(".docx"):
                raise ValueError("DOCX-labelled content lacks required OOXML parts")
            return {"kind": "zip-container", "status": "crc-verified", "expandedRecursively": False}
    legacy = legacy_doc_identity(data)
    if legacy:
        return {**legacy, "status": "legacy-format-identified", "sourceContentJudged": False}
    if name.lower().endswith(".docx"):
        raise ValueError("DOCX-labelled content is not a ZIP/OOXML container")
    return {"kind": "pdf" if data.startswith(b"%PDF-") else "other-binary", "status": "bytes-only", "sourceContentJudged": False}


def failure(error, stage):
    return {"stage": stage, "type": type(error).__name__, "message": str(error)}


def rar_metadata(payload, dependency_manifest):
    if dependency_manifest is None:
        raise ValueError("RAR header dependency manifest is required; no implicit global package")
    path = absolute(dependency_manifest)
    manifest_bytes = path.read_bytes()
    manifest = json.loads(manifest_bytes.decode("utf-8-sig"))
    if manifest.get("package") != "rarfile" or manifest.get("version") != "4.2" or manifest.get("sourceSha256") != RARFILE_SOURCE_SHA or manifest.get("pypiSha256") != RARFILE_WHEEL_SHA:
        raise ValueError("Pinned rarfile 4.2 dependency identity mismatch")
    if manifest.get("installedSource") != "python/rarfile.py":
        raise ValueError("Unexpected dependency source path")
    source = path.parent / "python/rarfile.py"
    if sha(source.read_bytes()) != RARFILE_SOURCE_SHA or sha((path.parent / manifest["wheelFile"]).read_bytes()) != RARFILE_WHEEL_SHA:
        raise ValueError("Pinned rarfile wheel/source SHA mismatch")
    loader = importlib.util.spec_from_file_location("dsh_pinned_rarfile", source)
    module = importlib.util.module_from_spec(loader)
    loader.loader.exec_module(module)
    if module.__version__ != "4.2":
        raise ValueError("Runtime rarfile version mismatch")
    def no_backend(*_args, **_kwargs):
        raise RuntimeError("rarfile external decompression backend forbidden")
    module.custom_popen = no_backend
    with module.RarFile(io.BytesIO(payload), errors="strict", crc_check=True) as archive:
        infos = archive.infolist()
    identity = {"manifestPath": str(path), "manifestSha256": sha(manifest_bytes), "version": module.__version__,
                "sourceSha256": RARFILE_SOURCE_SHA, "wheelSha256": RARFILE_WHEEL_SHA, "license": manifest["license"],
                "sdkScope": "RarFile(...errors='strict',crc_check=True).infolist() only; external backend forbidden",
                "externalDecompressionBackendInvoked": False}
    return infos, identity


def member_record(parent, meta, data, error, artifacts, limit):
    ordinal, name = meta["ordinal"], meta["name"]
    identifier = "derived-" + sha(("archive-member-v1\0" + parent["sha256"] + "\0" + str(ordinal)).encode())
    row = {**meta, "derivedAssetId": identifier, "parentAssetId": parent["assetId"], "parentSha256": parent["sha256"],
           "sourceChain": [{"assetId": parent["assetId"], "sourcePath": parent["path"], "sha256": parent["sha256"]},
                           {"kind": "archive-member", "ordinal": ordinal, "name": name, "derivedAssetId": identifier}],
           "nameSafety": name_safety(name), "role": "unclassified", "semanticJudgment": False,
           "status": "pending", "contentSha256": None, "contentFile": None, "decodedBytes": len(data),
           "crcOrReaderVerified": error is None and meta["type"] != "directory", "failures": []}
    if error is not None:
        row.update(status="reader-failed", failures=[failure(error, "member-decode-or-crc")])
        return row
    row["contentSha256"] = sha(data)
    if not row["nameSafety"]["safe"]:
        row.update(status="rejected", exclusionReason=row["nameSafety"]["reason"])
        return row
    basename = name.replace("\\", "/").split("/")[-1]
    excluded = "directory" if meta["type"] == "directory" else "link-or-special" if meta["type"] != "file" else ".DS_Store" if basename == ".DS_Store" else "AppleDouble" if data.startswith(bytes.fromhex("00051607")) else None
    if excluded:
        row.update(status="technically-excluded", exclusionReason=excluded, role="not-applicable-technical-metadata")
        return row
    path = "members/" + parent["sha256"] + "/" + f"{ordinal:06d}" + "-" + identifier + ".bin"
    row["contentFile"] = artifacts.write(path, data)
    row["savedReadbackSha256"] = sha((artifacts.directory / row["contentFile"]).read_bytes())
    row["sourceChain"][-1]["contentSha256"] = row["contentSha256"]
    try:
        row["validation"] = validate_content(data, name, limit)
        row["status"] = "retained"
    except Exception as error:
        row.update(status="retained-validation-failed", failures=[failure(error, "mechanical-content-readback")])
    return row


def inventory_archives(specification, artifacts, zip_name_encoding=None, dll=DEFAULT_DLL, limit=MAX_MEMBER_BYTES, rarfile_manifest=None):
    if specification.get("originalPhysicalDenominator", 715) != 715:
        raise ValueError("Original denominator is frozen at 715; derived assets must be separate")
    reports, reader_identity, header_identity = [], None, None
    for parent in specification["archives"]:
        metadata = None
        source = absolute(parent["path"])
        before = source.read_bytes()
        report = {"parent": parent, "sourceSha256Before": sha(before), "sourceSha256After": None,
                  "sourceUnchanged": False, "members": [], "scanComplete": False, "partial": True, "failures": []}
        reports.append(report)
        try:
            if sha(before) != parent["sha256"]:
                raise ValueError("Parent source SHA differs from declared identity")
            if not re.fullmatch(r"[a-f0-9]{64}", parent["sha256"]):
                raise ValueError("Parent source SHA must be exact SHA256")
            if before.startswith(b"PK"):
                report["format"] = "zip"
                with zipfile.ZipFile(io.BytesIO(before)) as archive:
                    for ordinal, info in enumerate(archive.infolist()):
                        content, error = b"", None
                        meta = {"ordinal": ordinal, "name": info.orig_filename, "type": "unknown", "declaredBytes": info.file_size}
                        try:
                            name, encoding = zip_name(info, zip_name_encoding)
                            mode = info.external_attr >> 16 if info.create_system == 3 else 0
                            kind = "directory" if stat.S_ISDIR(mode) or info.is_dir() or bool(info.external_attr & 0x10) else "file" if not mode or stat.S_ISREG(mode) else "link-or-special"
                            meta = {"ordinal": ordinal, "name": name, "type": kind, "mode": mode,
                                    "declaredBytes": info.file_size, "nameEncoding": encoding, "crc32": f"{info.CRC:08x}",
                                    "zipFlags": info.flag_bits, "localHeaderOffset": info.header_offset}
                            if info.file_size > limit:
                                raise ValueError("Member size exceeds configured limit")
                            with archive.open(info) as stream:
                                content = stream.read(limit + 1)
                            if len(content) > limit or len(content) != info.file_size:
                                raise ValueError("ZIP decoded member size differs or exceeds limit")
                            meta.update(crcVerified=True, crcKind="zip-crc32", actualCrc32=f"{zlib.crc32(content):08x}")
                        except Exception as problem:
                            error = problem
                            meta["crcVerified"] = False
                        report["members"].append(member_record(parent, meta, content, error, artifacts, limit))
            elif before.startswith(b"Rar!\x1a\x07"):
                report["format"] = "rar5" if before.startswith(b"Rar!\x1a\x07\x01\0") else "rar4"
                metadata, header_identity = rar_metadata(before, rarfile_manifest)
                reader = LibArchive(dll)
                reader_identity = reader.identity
                count = 0
                for meta, data, error in reader.entries(before, limit):
                    ordinal = meta["ordinal"]
                    count += 1
                    try:
                        if ordinal >= len(metadata):
                            raise ValueError("libarchive ordinal has no independent RAR header")
                        info = metadata[ordinal]
                        raw_name = info.orig_filename
                        original_name = raw_name.decode("utf-8", errors="strict") if report["format"] == "rar5" else info.filename
                        expected_name = info.filename.replace("\\", "/").rstrip("/")
                        if meta["name"].replace("\\", "/").rstrip("/") != expected_name or meta["declaredBytes"] != info.file_size or (meta["type"] == "directory") != info.isdir():
                            raise ValueError("RAR header/decode ordinal name/type/size mismatch")
                        meta.update(name=original_name, readerName=meta["name"], headerMetadataCrossChecked=True)
                        meta["nameEncoding"].update(rawNameBytesHex=raw_name.hex(), rawNameBytesSource="rarfile 4.2 original file-header name bytes; strict RAR5 UTF-8 decode")
                        if meta["type"] == "directory":
                            meta.update(crcVerified=False, crcKind="not-applicable-directory")
                        elif info.CRC is None:
                            raise ValueError("RAR header has no CRC32; independent checksum remains unverified")
                        else:
                            actual_crc = zlib.crc32(data)
                            meta.update(crcKind="rar-header-independent-crc32", crc32=f"{info.CRC:08x}", actualCrc32=f"{actual_crc:08x}", crcVerified=actual_crc == info.CRC)
                            if actual_crc != info.CRC:
                                raise ValueError("RAR independent data CRC32 mismatch")
                    except Exception as problem:
                        error = error or problem
                        meta["crcVerified"] = False
                    report["members"].append(member_record(parent, meta, data, error, artifacts, limit))
                    if error is not None:
                        raise RuntimeError("RAR scan stopped at independently rejected ordinal " + str(ordinal) + ": " + str(error))
                if count != len(metadata):
                    raise ValueError("RAR decoder/header member counts differ")
                if sha(reader.path.read_bytes()) != reader.identity["sha256"]:
                    raise ValueError("libarchive DLL changed while reading")
            else:
                raise ValueError("Unsupported or corrupt archive signature")
            report["scanComplete"] = True
        except Exception as error:
            report["failures"].append(failure(error, "archive-scan"))
        finally:
            report["sourceSha256After"] = sha(source.read_bytes())
            report["sourceUnchanged"] = report["sourceSha256Before"] == report["sourceSha256After"]
            if not report["sourceUnchanged"]:
                report["failures"].append({"stage": "source-preservation", "message": "Source SHA changed"})
            report["partial"] = not report["scanComplete"] or any(r["status"] in ("reader-failed", "rejected", "retained-validation-failed") for r in report["members"])
            if metadata is not None and not report["scanComplete"]:
                decoded = len(report["members"])
                for ordinal, info in enumerate(metadata[decoded:], decoded):
                    raw_name = info.orig_filename
                    pending_name = raw_name.decode("utf-8", errors="strict") if report["format"] == "rar5" else info.filename
                    meta = {"ordinal": ordinal, "name": pending_name, "type": "directory" if info.isdir() else "file", "declaredBytes": info.file_size,
                            "nameEncoding": {"rawNameBytesHex": raw_name.hex(), "scope": "Independent header parsed; content was not decoded after earlier failure"}}
                    row = member_record(parent, meta, b"", RuntimeError("Not decoded after earlier archive/CRC failure"), artifacts, limit)
                    row.update(status="not-decoded", decodedBytes=None)
                    row["failures"][0]["stage"] = "not-decoded-after-earlier-error"
                    report["members"].append(row)
                report["headerMemberCount"] = len(metadata)
                report["unreadMemberCount"] = len(metadata) - decoded
            else:
                report["unreadMemberCount"] = 0 if report["scanComplete"] else "unknown; header parsing stopped before complete enumeration"
    rows = [r for archive in reports for r in archive["members"]]
    duplicates = {}
    for row in rows:
        if row["status"] == "retained":
            duplicates.setdefault(row["contentSha256"], []).append(row["derivedAssetId"])
    result = {"schemaVersion": 1, "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "sourceKind": specification.get("sourceKind", "original archive technical member inventory"),
              "originalPhysicalDenominator": 715, "originalDenominatorChanged": False, "originalLedgerModified": False,
              "derivedAssetsSeparate": True, "manuscriptContentJudgment": False, "semanticRoleAssigned": False,
              "modelCalls": 0, "realArkCalls": 0, "apiRequests": 0, "servicesStarted": 0,
              "implementation": {"toolSha256": sha(Path(__file__).read_bytes()), "pythonVersion": sys.version,
                                 "zipfileSourceSha256": sha(Path(zipfile.__file__).read_bytes()), "rarReader": reader_identity, "rarHeaderReader": header_identity,
                                 "primarySources": PRIMARY_SOURCES, "memberPathsUsedForWrites": False},
              "archives": reports, "memberCount": len(rows), "retained": sum(r["status"] == "retained" for r in rows),
              "excluded": sum(r["status"] == "technically-excluded" for r in rows), "rejected": sum(r["status"] == "rejected" for r in rows),
              "failed": sum(r["status"] in ("reader-failed", "retained-validation-failed") for r in rows),
              "notDecoded": sum(r["status"] == "not-decoded" for r in rows),
              "duplicateContentCandidates": [{"sha256": h, "derivedAssetIds": ids, "familyConfirmed": False} for h, ids in duplicates.items() if len(ids) > 1],
              "scope": "Technical names/types, actual CRC/decoder content, content hashes and mechanical DOCX/legacy format readback; no conversion, role/family confirmation or semantic assessment."}
    result["ok"] = all(a["scanComplete"] and a["sourceUnchanged"] and not a["failures"] for a in reports) and result["failed"] == 0
    result["partial"] = any(a["partial"] for a in reports)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-list", type=Path, required=True)
    parser.add_argument("--run-pointer", type=Path, default=ROOT / "tmp/asset-ingestion-current-run.json")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--zip-name-encoding", choices=("utf-8", "cp437", "cp936"))
    parser.add_argument("--libarchive", type=Path, default=DEFAULT_DLL)
    parser.add_argument("--rarfile-manifest", type=Path, help="Explicit pinned rarfile 4.2 dependency manifest; required for RAR")
    args = parser.parse_args()
    pointer = json.loads(args.run_pointer.read_text(encoding="utf-8-sig"))
    run = checked_run(pointer)
    out = absolute(args.out or run / "artifacts" / ("archive-" + str(int(time.time() * 1000)) + "-" + uuid.uuid4().hex[:8]))
    source_list_bytes = args.source_list.read_bytes()
    specification = json.loads(source_list_bytes.decode("utf-8-sig"))
    if not isinstance(specification.get("archives"), list) or not specification["archives"]:
        raise ValueError("Source list must include nonempty archives")
    for parent in specification["archives"]:
        if not isinstance(parent.get("assetId"), str) or not parent["assetId"] or not isinstance(parent.get("path"), str) or not Path(parent["path"]).is_absolute() or not re.fullmatch(r"[a-f0-9]{64}", parent.get("sha256", "")):
            raise ValueError("Every archive needs explicit parent asset, absolute path and SHA256")
    baseline = absolute(specification["baselineInventory"]) if specification.get("baselineInventory") else None
    baseline_before = baseline.read_bytes() if baseline else None
    if baseline_before is not None:
        baseline_object = json.loads(baseline_before.decode("utf-8-sig"))
        if sha(baseline_before) != specification["baselineInventorySha256"] or baseline_object["summary"]["physicalFiles"] != 715 or baseline_object["inventoryHash"] != specification["baselineInventoryIdentity"]:
            raise ValueError("Frozen original inventory does not match source-list identity/715 denominator")
    artifacts = ArtifactRoot(run, out)
    result = inventory_archives(specification, artifacts, args.zip_name_encoding, args.libarchive, rarfile_manifest=args.rarfile_manifest)
    result.update(runId=pointer["runId"], sourceListPath=str(args.source_list.absolute()), sourceListSha256=sha(source_list_bytes), outputDirectory=str(out))
    if baseline is not None:
        after = baseline.read_bytes()
        result["originalInventoryProof"] = {"path": str(baseline), "beforeSha256": sha(baseline_before), "afterSha256": sha(after), "unchanged": after == baseline_before, "physicalFiles": 715, "inventoryHash": specification["baselineInventoryIdentity"]}
        if after != baseline_before:
            result["ok"] = False
            result["partial"] = True
    artifacts.write("manifest.json", json_bytes(result))
    print(json.dumps({"out": str(out / "manifest.json"), "ok": result["ok"], "partial": result["partial"],
                      "members": result["memberCount"], "retained": result["retained"], "excluded": result["excluded"], "failed": result["failed"]}))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
