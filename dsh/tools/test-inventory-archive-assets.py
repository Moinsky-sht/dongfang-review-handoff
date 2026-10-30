"""Software-only archive regression: real zipfile/libarchive reads, generated inert members."""
import importlib.util
import argparse
import io
import json
import os
from pathlib import Path
import struct
import time
import uuid
import warnings
import subprocess
import zipfile
import zlib
import sys

sys.dont_write_bytecode = True
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--rarfile-manifest", type=Path, required=True)
arguments = parser.parse_args()

HERE = Path(__file__).absolute().parent
spec = importlib.util.spec_from_file_location("archive_inventory", HERE / "inventory-archive-assets.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
pointer = json.loads((module.ROOT / "tmp/asset-ingestion-current-run.json").read_text(encoding="utf-8-sig"))
run = module.checked_run(pointer)
top = module.ArtifactRoot(run, run / "artifacts" / ("archive-software-tests-" + str(int(time.time() * 1000)) + "-" + uuid.uuid4().hex[:8]))
checks = []
case = 0


def check(name, function):
    try:
        function()
        checks.append({"name": name, "ok": True})
        print("PASS " + name)
    except Exception as error:
        checks.append({"name": name, "ok": False, "error": {"type": type(error).__name__, "message": str(error)}})
        print("FAIL " + name + ": " + str(error))


def docx(text="SOFTWARE-ONLY XML text; no content role or quality label"):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' + text + '</w:t></w:r></w:p></w:body></w:document>')
    return stream.getvalue()


def zip_bytes(entries):
    stream = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with zipfile.ZipFile(stream, "w", zipfile.ZIP_STORED) as archive:
            for name, content, mode in entries:
                info = zipfile.ZipInfo(name)
                info.create_system = 3
                info.external_attr = mode << 16
                archive.writestr(info, content)
    return stream.getvalue()


def vint(value):
    output = bytearray()
    while value >= 128:
        output.append((value & 127) | 128)
        value >>= 7
    output.append(value)
    return bytes(output)


def rar_header(body):
    record = vint(len(body)) + body
    return struct.pack("<I", zlib.crc32(record)) + record


def rar5_bytes(entries):
    """Only generate stored RAR5 fixtures per rarlab technote; all decoding is libarchive."""
    archive = bytearray(b"Rar!\x1a\x07\x01\0" + rar_header(vint(1) + vint(0) + vint(0)))
    for name, content, directory in entries:
        name_bytes = name.encode("utf-8")
        fields = [2, 2, len(content), 4 | (1 if directory else 0), len(content), 0o40755 if directory else 0o100644]
        body = b"".join(vint(i) for i in fields) + struct.pack("<I", zlib.crc32(content)) + vint(0) + vint(1) + vint(len(name_bytes)) + name_bytes
        archive.extend(rar_header(body) + content)
    archive.extend(rar_header(vint(5) + vint(0) + vint(0)))
    return bytes(archive)


def execute(payload, suffix, encoding=None, dependency=None, limit=module.MAX_MEMBER_BYTES):
    global case
    case += 1
    filename = top.write("fixtures/" + f"{case:03d}" + suffix, payload)
    source = top.directory / filename
    output = module.ArtifactRoot(run, top.directory / ("case-" + f"{case:03d}"))
    result = module.inventory_archives({"sourceKind": "generated inert software archive fixture", "archives": [{"assetId": "software-parent-" + str(case), "path": str(source), "sha256": module.sha(payload)}]}, output, encoding, limit=limit, rarfile_manifest=dependency or arguments.rarfile_manifest)
    output.write("manifest.json", module.json_bytes(result))
    assert source.read_bytes() == payload
    assert result["originalPhysicalDenominator"] == 715 and not result["originalDenominatorChanged"]
    return result, output


def duplicate_zip():
    a, b = docx("SOFTWARE A"), docx("SOFTWARE B")
    result, output = execute(zip_bytes([("重名.docx", a, 0o100644), ("重名.docx", b, 0o100644)]), ".zip")
    rows = result["archives"][0]["members"]
    assert result["ok"] and result["retained"] == 2
    assert rows[0]["name"] == rows[1]["name"] == "重名.docx"
    assert rows[0]["derivedAssetId"] != rows[1]["derivedAssetId"] and rows[0]["contentFile"] != rows[1]["contentFile"]
    assert (output.directory / rows[0]["contentFile"]).read_bytes() == a
    assert (output.directory / rows[1]["contentFile"]).read_bytes() == b


def unsafe_names():
    names = ["../escape.docx", "/absolute.docx", "C:\\escape.docx", "nested/../../escape.docx", "file:stream.docx"]
    result, output = execute(zip_bytes([(n, docx(), 0o100644) for n in names]), ".zip")
    assert result["rejected"] == len(names) and result["retained"] == 0 and result["partial"]
    assert not (output.directory / "members").exists()
    assert all(r["contentFile"] is None for r in result["archives"][0]["members"])


def zip_directory_metadata():
    result, _ = execute(zip_bytes([("目录没有斜线", b"", 0o40755), ("正常.docx", docx(), 0o100644)]), ".zip")
    rows = result["archives"][0]["members"]
    assert rows[0]["type"] == "directory" and rows[0]["status"] == "technically-excluded"
    assert result["retained"] == 1


def system_metadata():
    result, _ = execute(zip_bytes([("__MACOSX/._普通.docx", bytes.fromhex("00051607") + b"SOFTWARE AppleDouble", 0o100644), (".DS_Store", b"SOFTWARE", 0o100644), ("._actual.docx", docx(), 0o100644)]), ".zip")
    assert result["excluded"] == 2 and result["retained"] == 1
    assert result["archives"][0]["members"][2]["role"] == "unclassified"


def zip_crc_failure():
    data = bytearray(zip_bytes([("bad.docx", docx(), 0o100644), ("good.docx", docx(), 0o100644)]))
    name_length, extra_length = struct.unpack_from("<HH", data, 26)
    data[30 + name_length + extra_length + 4] ^= 1
    result, _ = execute(bytes(data), ".zip")
    rows = result["archives"][0]["members"]
    assert not result["ok"] and result["partial"] and result["failed"] == 1 and result["retained"] == 1
    assert rows[0]["status"] == "reader-failed" and not rows[0]["crcOrReaderVerified"] and rows[0]["contentFile"] is None
    assert result["archives"][0]["scanComplete"]


def zip_bad_container():
    result, _ = execute(b"PK\x03\x04CORRUPT SOFTWARE", ".zip")
    assert not result["ok"] and not result["archives"][0]["scanComplete"] and result["archives"][0]["failures"]


def unflagged_utf8():
    data = bytearray(zip_bytes([("中文.docx", docx(), 0o100644)]))
    local_flags = struct.unpack_from("<H", data, 6)[0]
    struct.pack_into("<H", data, 6, local_flags & ~0x800)
    central = data.rindex(b"PK\x01\x02")
    flags = struct.unpack_from("<H", data, central + 8)[0]
    struct.pack_into("<H", data, central + 8, flags & ~0x800)
    result, _ = execute(bytes(data), ".zip", "utf-8")
    row = result["archives"][0]["members"][0]
    assert result["ok"] and row["name"] == "中文.docx"
    assert not row["nameEncoding"]["archiveDeclaredUnicode"] and row["nameEncoding"]["explicitOverride"] == "utf-8"
    assert row["nameEncoding"]["rawNameBytesHex"] == "中文.docx".encode().hex()


def invalid_docx_retained():
    result, output = execute(zip_bytes([("invalid.docx", b"SOFTWARE non-DOCX bytes", 0o100644)]), ".zip")
    row = result["archives"][0]["members"][0]
    assert not result["ok"] and row["status"] == "retained-validation-failed"
    assert (output.directory / row["contentFile"]).read_bytes() == b"SOFTWARE non-DOCX bytes"


def rar_types_names_duplicate():
    entries = [("中文目录无斜线", b"", True), ("中文目录/重复.docx", docx("SOFTWARE A"), False), ("中文目录/重复.docx", docx("SOFTWARE B"), False)]
    result, output = execute(rar5_bytes(entries), ".rar")
    rows = result["archives"][0]["members"]
    assert result["ok"] and result["retained"] == 2 and result["excluded"] == 1
    assert rows[0]["type"] == "directory" and not rows[0]["name"].endswith("/")
    assert rows[1]["name"] == rows[2]["name"] == "中文目录/重复.docx"
    assert rows[1]["contentFile"] != rows[2]["contentFile"]
    assert (output.directory / rows[1]["contentFile"]).read_bytes() == entries[1][1]
    assert (output.directory / rows[2]["contentFile"]).read_bytes() == entries[2][1]
    assert result["implementation"]["rarReader"]["archiveWriteOrExtractAPIUsed"] is False


def rar_crc_failure():
    payload = rar5_bytes([("损坏.docx", docx(), False), ("以后.docx", docx(), False)])
    data = bytearray(payload)
    offset = data.index(b"PK\x03\x04")
    data[offset + 4] ^= 1
    result, _ = execute(bytes(data), ".rar")
    assert not result["ok"] and result["partial"] and not result["archives"][0]["scanComplete"]
    assert result["archives"][0]["members"][0]["status"] == "reader-failed"
    assert result["archives"][0]["members"][0]["contentFile"] is None
    assert result["notDecoded"] == 1 and result["archives"][0]["members"][1]["status"] == "not-decoded"
    assert result["archives"][0]["unreadMemberCount"] == 1


def rar_header_failure():
    data = bytearray(rar5_bytes([("正常.docx", docx(), False)]))
    data[8] ^= 1
    result, _ = execute(bytes(data), ".rar")
    assert not result["ok"] and result["archives"][0]["failures"] and not result["archives"][0]["scanComplete"]


def rar_unsafe():
    result, _ = execute(rar5_bytes([("../escape.docx", docx(), False), ("正常.docx", docx(), False)]), ".rar")
    assert result["rejected"] == 1 and result["retained"] == 1


def duplicate_hash_is_candidate():
    content = docx()
    result, _ = execute(zip_bytes([("a.docx", content, 0o100644), ("b.docx", content, 0o100644)]), ".zip")
    assert len(result["duplicateContentCandidates"]) == 1 and not result["duplicateContentCandidates"][0]["familyConfirmed"]


def output_guards():
    try:
        module.ArtifactRoot(run, top.directory)
        raise AssertionError("Existing output accepted")
    except FileExistsError:
        pass
    try:
        module.ArtifactRoot(run, module.ROOT / "tmp" / ("must-not-exist-" + uuid.uuid4().hex))
        raise AssertionError("Outside output accepted")
    except ValueError:
        pass
    sealed = top.directory / "sealed-proof"
    sealed.mkdir()
    (sealed / "complete.json").write_bytes(b"SOFTWARE sealed marker")
    try:
        module.ArtifactRoot(run, sealed / "must-not-exist")
        raise AssertionError("Sealed output accepted")
    except ValueError:
        pass
    assert not (sealed / "must-not-exist").exists()


def dependency_tamper_rejected():
    value = json.loads(arguments.rarfile_manifest.read_text(encoding="utf-8-sig"))
    value["sourceSha256"] = "0" * 64
    path = top.directory / top.write("tampered-dependency-manifest.json", module.json_bytes(value))
    result, _ = execute(rar5_bytes([("软件.docx", docx(), False)]), ".rar", dependency=path)
    assert not result["ok"] and "identity mismatch" in result["archives"][0]["failures"][0]["message"]
    assert result["memberCount"] == 0


def bounded_content():
    result, output = execute(zip_bytes([("large.docx", docx(), 0o100644)]), ".zip", limit=8)
    assert result["failed"] == 1 and not (output.directory / "members").exists()


def output_alias_rejected():
    target, alias = top.directory / "alias-target", top.directory / "alias-root"
    target.mkdir()
    quote = lambda p: "'" + str(p).replace("'", "''") + "'"
    command = "New-Item -ItemType Junction -Path " + quote(alias) + " -Target " + quote(target) + " | Out-Null"
    process = subprocess.run(["powershell", "-NoProfile", "-Command", command], capture_output=True, timeout=20)
    assert process.returncode == 0, process.stderr.decode(errors="replace")
    try:
        module.ArtifactRoot(run, alias / "must-not-exist")
        raise AssertionError("Alias output accepted")
    except ValueError:
        pass
    assert not (target / "must-not-exist").exists()


def legacy_doc_type_scope():
    data = bytearray(1024)
    data[:8] = bytes.fromhex("d0cf11e0a1b11ae1")
    struct.pack_into("<H", data, 30, 9)
    struct.pack_into("<I", data, 48, 0)
    name = "WordDocument\0".encode("utf-16-le")
    data[512:512 + len(name)] = name
    struct.pack_into("<H", data, 512 + 64, len(name))
    data[512 + 66] = 2
    identity = module.legacy_doc_identity(bytes(data))
    assert identity["kind"] == "legacy-doc" and identity["needsConversion"] and not identity["bodyParsePerformed"]


for name, function in [
    ("ZIP exact duplicate names do not overwrite and Chinese UTF-8 survives", duplicate_zip),
    ("ZIP traversal/absolute/drive/ADS names rejected without member-path writes", unsafe_names),
    ("ZIP directory without slash identified by actual metadata", zip_directory_metadata),
    ("AppleDouble and DS_Store excluded; literal dot-underscore DOCX retained", system_metadata),
    ("ZIP CRC failure is a failed row; later valid row remains distinct", zip_crc_failure),
    ("ZIP corrupt container is explicit incomplete enumeration", zip_bad_container),
    ("Unflagged UTF-8 explicit override retains raw/specification names", unflagged_utf8),
    ("Invalid DOCX content retained but never called parse success", invalid_docx_retained),
    ("RAR actual decoder handles Chinese/duplicate names and no-slash directory", rar_types_names_duplicate),
    ("RAR content CRC failure stops with explicit partial and failed row", rar_crc_failure),
    ("RAR corrupt header is explicit scan failure", rar_header_failure),
    ("RAR unsafe member rejected while later valid ordinal preserved", rar_unsafe),
    ("Duplicate bytes are only a hash candidate, never a family confirmation", duplicate_hash_is_candidate),
    ("Output wx/outer boundary/sealed ancestor guards prevent writes", output_guards),
    ("Pinned metadata dependency tamper is rejected before member decode", dependency_tamper_rejected),
    ("Declared member size bound prevents content writes", bounded_content),
    ("Real Windows output junction alias is rejected without following it", output_alias_rejected),
    ("Legacy DOC identification states exact CFB directory-only scope", legacy_doc_type_scope),
]:
    check(name, function)
report = {"schemaVersion": 1, "runId": pointer["runId"], "softwareOnly": True, "fixtureKind": "Generated inert ZIP and stored RAR5, decoded by mature zipfile/libarchive",
          "modelCalls": 0, "apiRequests": 0, "serversStarted": 0, "manuscriptContentJudgment": False,
          "passed": sum(c["ok"] for c in checks), "failed": sum(not c["ok"] for c in checks), "total": len(checks),
          "toolSha256": module.sha((HERE / "inventory-archive-assets.py").read_bytes()), "testSha256": module.sha(Path(__file__).read_bytes()), "checks": checks}
report["ok"] = report["failed"] == 0
top.write("report.json", module.json_bytes(report))
print(json.dumps({"out": str(top.directory / "report.json"), "passed": report["passed"], "failed": report["failed"], "ok": report["ok"]}))
raise SystemExit(0 if report["ok"] else 1)
