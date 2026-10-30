"""Read-only, page-level PDF intake evidence. No OCR, role, or quality judgment."""
from __future__ import annotations
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
from datetime import datetime, timezone
import warnings

PROJECT = Path(__file__).absolute().parent.parent
RUNS = PROJECT / "data" / "optimization" / "runs"

def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def guarded_output(path: Path, create: bool = False) -> Path:
    path = Path(os.path.abspath(path))
    try:
        rel = path.relative_to(RUNS)
    except ValueError as error:
        raise ValueError("Evidence output must belong to an optimization run") from error
    if len(rel.parts) < 2:
        raise ValueError("Evidence output needs a fresh subdirectory in a run")
    for ancestor in [path, *path.parents]:
        try:
            info = ancestor.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("Evidence aliases and reparse points are not permitted")
        marker = ancestor / "complete.json"
        try:
            marker.lstat()
        except FileNotFoundError:
            pass
        else:
            raise ValueError("Evidence run is already sealed")
    run = RUNS / rel.parts[0]
    registration = run / "run.json"
    if not registration.is_file():
        raise ValueError("Expected a registered optimization run")
    registration_info = registration.lstat()
    if stat.S_ISLNK(registration_info.st_mode) or getattr(registration_info, "st_file_attributes", 0) & 0x400:
        raise ValueError("Run registration aliases are not permitted")
    if create:
        path.mkdir(parents=True, exist_ok=False)
        guarded_output(path)
    return path

def write_json(path: Path, value: object) -> dict:
    guarded_output(path)
    data = (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
    with path.open("xb") as stream:
        stream.write(data)
    return {"path": str(path.relative_to(PROJECT)).replace("\\", "/"), "sha256": sha(data), "bytes": len(data)}

def coordinate_evidence(path: Path, value: dict, candidate: dict | None) -> dict:
    """Freshly extract first; reuse immutable bytes only after exact comparison."""
    if candidate:
        target = Path(os.path.abspath(PROJECT / candidate["path"]))
        target.relative_to(RUNS)
        for ancestor in [target, *target.parents]:
            info = ancestor.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise ValueError("Coordinate reuse aliases are not permitted")
        saved = target.read_bytes()
        if sha(saved) != candidate["sha256"] or len(saved) != candidate["bytes"]:
            raise ValueError("Coordinate reuse bytes differ from their recorded identity")
        fresh = (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
        if saved == fresh:
            return {**candidate, "reused": True, "validatedByFreshExtraction": True}
    return write_json(path, value)

def error_record(error: BaseException) -> dict:
    return {"type": type(error).__name__, "message": str(error)[:1000]}

def range_view(units: list[int], bounded: str, characters: list) -> dict:
    """Raw GetText indices own UTF-16 units, never the bounded Unicode view."""
    text = []
    unit_spans = [None] * len(units)
    unit_scalars = [None] * len(units)
    invalid_units = []
    index = 0
    while index < len(units):
        value = units[index]
        count = 1
        if 0xD800 <= value <= 0xDBFF and index + 1 < len(units) and 0xDC00 <= units[index + 1] <= 0xDFFF:
            scalar = 0x10000 + (value - 0xD800) * 0x400 + units[index + 1] - 0xDC00
            count = 2
        elif 0xD800 <= value <= 0xDFFF:
            scalar = 0xFFFD
            invalid_units.append(index)
        else:
            scalar = value
        span = [len(text), len(text) + 1]
        text.append(chr(scalar))
        for offset in range(index, index + count):
            if index not in invalid_units:
                unit_spans[offset] = span
                unit_scalars[offset] = scalar
        index += count
    range_text = "".join(text)
    offsets = []
    failures = []
    for char in characters:
        raw_value, text_index = char[1], char[2]
        if text_index < 0:
            reason = "character_excluded_from_range_api_text"
        elif text_index >= len(units):
            reason = "range_api_index_out_of_returned_units"
        elif unit_spans[text_index] is None:
            reason = "invalid_utf16_range_unit"
        elif raw_value != units[text_index] and raw_value != unit_scalars[text_index]:
            reason = "raw_api_unicode_value_disagrees_with_range_text"
        else:
            reason = None
        offsets.append(None if reason else unit_spans[text_index])
        if reason:
            failures.append({"charIndex": char[0], "rangeUtf16Index": text_index, "reason": reason})
    same = not invalid_units and range_text == bounded
    return {"rangeText": range_text, "rangeTextSha256": sha(range_text.encode("utf-8")),
            "rangeUtf16Units": units, "rangeUtf16UnitCount": len(units),
            "rangeIndexOwner": "FPDFText_GetText full-range UTF-16 units, excluding trailing NUL; FPDFText_GetTextIndexFromCharIndex belongs to this view",
            "rangePythonOffsets": offsets, "rangePythonOffsetsUnit": "Unicode scalar/codepoint offsets, end-exclusive; paired surrogate API characters may share one scalar span",
            "rangeMappingFailures": failures, "invalidRangeUtf16Units": invalid_units,
            "rangeBoundedTextExactlyEqual": same,
            "boundedMapping": {"status": "exact_text_identity" if same else "unmapped_different_api_view",
                               "useRangeOffsets": same, "mappedCharacters": sum(o is not None for o in offsets) if same else 0,
                               "reason": None if same else "Bounded rectangle UTF-16 output and full-range API text differ; no substring guessing or index reuse is permitted"}}

def inspect_pdf(source: Path, asset: dict, out: Path, reuse: dict | None = None) -> dict:
    import pypdfium2 as pdfium
    from pypdf import PdfReader
    original = source.read_bytes()
    expected = asset["sourceSha256"]
    if sha(original) != expected:
        raise ValueError("Original PDF differs from its immutable inventory")
    row = {"assetId": asset["assetId"], "sourcePath": asset["relativePath"], "sourceSha256": expected,
           "bytes": len(original), "role": "unclassified", "sourceModified": False,
           "semanticJudgment": False, "realArkCalls": 0, "pages": [], "errors": [], "parserWarnings": []}
    dest = out / asset["assetId"]
    guarded_output(dest, create=True)
    reader = None
    document = None
    try:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            reader = PdfReader(source, strict=False)
            row["encrypted"] = bool(reader.is_encrypted)
            if reader.is_encrypted:
                # Ordinary read access with the default empty user password; never
                # rewrite/decrypt the source or guess an actual user password.
                row["defaultEmptyPasswordRead"] = bool(reader.decrypt(""))
                if not row["defaultEmptyPasswordRead"]:
                    row["status"] = "password_required_not_processed"
                    row["errors"].append({"type": "PasswordRequired", "message": "No actual password was supplied or guessed"})
                    raise ValueError("PDF requires a non-empty user password")
            row["pypdfPageCount"] = len(reader.pages)
            document = pdfium.PdfDocument(source)
            row["pdfiumPageCount"] = len(document)
            row["pageCount"] = len(document)
            row["independentPageCountAgreement"] = row["pdfiumPageCount"] == row["pypdfPageCount"]
            for ordinal in range(len(document)):
                page = None
                textpage = None
                result = {"pageIndex": ordinal, "pageNumber": ordinal + 1,
                          "sourceSha256": expected, "status": "pending",
                          "coordinateConvention": "PDFium get_charbox left/bottom/right/top in PDF canvas units; native API frame, bbox and rotation recorded"}
                try:
                    page = document[ordinal]
                    textpage = page.get_textpage()
                    char_count = textpage.count_chars()
                    text = textpage.get_text_bounded()
                    range_buffer = (ctypes.c_ushort * (char_count + 1))()
                    written = pdfium.raw.FPDFText_GetText(textpage, 0, char_count, range_buffer)
                    if written < 0 or written > char_count + 1:
                        raise ValueError("Full-range API returned an invalid UTF-16 unit count")
                    range_units = list(range_buffer[:max(0, written - 1)])
                    boxes = []
                    box_errors = []
                    for index in range(char_count):
                        codepoint = pdfium.raw.FPDFText_GetUnicode(textpage, index)
                        text_index = pdfium.raw.FPDFText_GetTextIndexFromCharIndex(textpage, index)
                        generated = pdfium.raw.FPDFText_IsGenerated(textpage, index)
                        try:
                            box = list(textpage.get_charbox(index))
                        except Exception as error:
                            box = None
                            box_errors.append({"charIndex": index, "error": error_record(error)})
                        boxes.append([index, codepoint, text_index, generated, box])
                    view = range_view(range_units, text, boxes)
                    image_count = sum(1 for _ in page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_IMAGE], max_depth=15))
                    annotations = reader.pages[ordinal].get("/Annots", []) if ordinal < len(reader.pages) else None
                    if hasattr(annotations, "get_object"):
                        annotations = annotations.get_object()
                    result.update({"status": "read", "width": page.get_width(), "height": page.get_height(),
                                   "bbox": list(page.get_bbox()), "rotation": page.get_rotation(),
                                   "charObjectCount": char_count, "extractedTextCharacters": len(text),
                                   "nonWhitespaceTextCharacters": len("".join(text.split())),
                                   "imageObjectCount": image_count, "imageEnumerationDepthLimit": 15,
                                   "annotationCount": len(annotations) if annotations is not None else None,
                                   "characterBoxFailures": len(box_errors),
                                   "rangeMappedCharacters": sum(o is not None for o in view["rangePythonOffsets"]),
                                   "rangeUnmappedCharacters": len(view["rangeMappingFailures"]),
                                   "boundedMappedCharacters": view["boundedMapping"]["mappedCharacters"],
                                   "boundedMappingStatus": view["boundedMapping"]["status"],
                                   "textLayerStatus": "present_unverified" if char_count else "no_character_objects_detected",
                                   "ocrDisposition": "pending_visual_and_ocr_validation",
                                   "ocrPerformed": False, "textAccuracyVerified": False,
                                   "pageRenderingVerified": False})
                    coordinates = {"sourceSha256": expected, "pageIndex": ordinal,
                                   "bbox": result["bbox"], "width": result["width"], "height": result["height"],
                                   "rotation": result["rotation"], "coordinateConvention": result["coordinateConvention"],
                                   "text": text, "textSha256": sha(text.encode("utf-8")),
                                   "characterRowFields": ["charIndex", "rawUnicodeApiValue", "rangeUtf16TextIndex", "isGenerated", "canvasBox"],
                                   "characters": boxes, "characterBoxErrors": box_errors,
                                   **view,
                                   "normalization": "Full-range UTF-16 text and bounded Unicode text are distinct API views. Raw values and validated range Python offsets are explicit; bounded ranges require exact view identity and are otherwise unmapped. No OCR, validated reading order, or editable Word range is claimed."}
                    result["coordinateEvidence"] = coordinate_evidence(dest / f"page-{ordinal + 1:04d}.json", coordinates, (reuse or {}).get(ordinal))
                except Exception as error:
                    result.update({"status": "failed", "error": error_record(error)})
                finally:
                    if textpage is not None:
                        textpage.close()
                    if page is not None:
                        page.close()
                row["pages"].append(result)
            row["status"] = "technical_read_completed" if row["independentPageCountAgreement"] and all(p["status"] == "read" for p in row["pages"]) else "partial_technical_read"
            row["parserWarnings"] = [str(w.message)[:1000] for w in caught]
    except Exception as error:
        if row.get("status") != "password_required_not_processed":
            row["status"] = "technical_read_failed"
        row["errors"].append(error_record(error))
    finally:
        if document is not None:
            document.close()
        if reader is not None and hasattr(reader, "close"):
            reader.close()
    row["sourceHashAfter"] = sha(source.read_bytes())
    if row["sourceHashAfter"] != expected:
        raise ValueError("Original PDF changed while it was being read")
    row["readPages"] = sum(p["status"] == "read" for p in row["pages"])
    row["failedPages"] = sum(p["status"] == "failed" for p in row["pages"])
    row["noCharacterObjectPages"] = sum(p["status"] == "read" and p.get("charObjectCount") == 0 for p in row["pages"])
    row["textLayerPages"] = sum(p["status"] == "read" and p.get("charObjectCount", 0) > 0 for p in row["pages"])
    row["intakeReady"] = False
    row["qualityStagePassed"] = False
    row["metadataEvidence"] = write_json(dest / "document.json", row)
    return row

def render_representatives(rows: list, root: Path, out: Path) -> list:
    import pypdfium2 as pdfium
    rendered = []
    choices = {}
    for row in rows:
        for page in row["pages"]:
            if page["status"] != "read":
                continue
            group = "without-character-objects" if page["charObjectCount"] == 0 else "with-character-objects"
            if group not in choices:
                choices[group] = (row, page)
    for group, (row, page) in choices.items():
        target = out / row["assetId"] / f"representative-{group}-page-{page['pageNumber']:04d}.png"
        guarded_output(target)
        if target.exists():
            raise FileExistsError(target)
        result = {"group": group, "assetId": row["assetId"], "sourcePath": row["sourcePath"],
                  "sourceSha256": row["sourceSha256"], "pageIndex": page["pageIndex"],
                  "scale": 1.3, "visualInspectionCompleted": False, "semanticJudgment": False}
        try:
            document = pdfium.PdfDocument(root / row["sourcePath"])
            pdf_page = document[page["pageIndex"]]
            bitmap = pdf_page.render(scale=1.3)
            picture = bitmap.to_pil()
            with target.open("xb") as stream:
                picture.save(stream, format="PNG")
            result.update({"status": "rendered", "path": str(target.relative_to(PROJECT)).replace("\\", "/"),
                           "sha256": sha(target.read_bytes()), "widthPixels": picture.width, "heightPixels": picture.height})
            picture.close(); bitmap.close(); pdf_page.close(); document.close()
        except Exception as error:
            result.update({"status": "failed", "error": error_record(error)})
        rendered.append(result)
    return rendered

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", default=str(PROJECT / "data/optimization/runs/baseline-20261009-f7bba6676b-99bf7867/inventory.json"))
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--reuse-coordinate-report", help="Optional prior immutable report; every page is still freshly read and compared byte for byte")
    args = parser.parse_args(argv)
    output = guarded_output(Path(args.out_dir), create=True)
    inventory_bytes = Path(args.inventory).read_bytes()
    inventory = json.loads(inventory_bytes)
    root = Path(inventory["sourceRoot"]).resolve()
    assets = [a for a in inventory["files"] if a["ext"] == ".pdf" and not a["exclusionReason"]]
    prior_rows = {}
    if args.reuse_coordinate_report:
        prior_path = Path(args.reuse_coordinate_report).resolve()
        prior_path.relative_to(RUNS)
        prior_report = json.loads(prior_path.read_bytes())
        prior_rows = {r["assetId"]: r for r in prior_report["rows"]}
    rows = []
    for asset in assets:
        source = (root / asset["relativePath"]).resolve()
        source.relative_to(root)
        if not source.is_file():
            raise ValueError("Inventory source is unavailable")
        prior = prior_rows.get(asset["assetId"])
        if prior and prior["sourceSha256"] != asset["sourceSha256"]:
            raise ValueError("Coordinate reuse report belongs to another source version")
        reuse = {p["pageIndex"]: p["coordinateEvidence"] for p in prior["pages"] if "coordinateEvidence" in p} if prior else None
        row = inspect_pdf(source, asset, output, reuse)
        rows.append(row)
        print(json.dumps({"assetId": row["assetId"], "status": row["status"], "pages": row.get("pageCount"), "readPages": row["readPages"]}), flush=True)
    rendered = render_representatives(rows, root, output)
    import pdfplumber, pypdf, pypdfium2
    report = {"schemaVersion": 1, "at": datetime.now(timezone.utc).isoformat(), "inventoryPath": str(args.inventory),
              "toolSha256": sha(Path(__file__).read_bytes()),
              "inventorySha256": sha(inventory_bytes), "originalInventoryHash": inventory["inventoryHash"],
              "originalPhysicalDenominator": inventory["summary"]["physicalFiles"], "selectedPdfPaths": len(assets),
              "technicalCompletedPaths": sum(r["status"] == "technical_read_completed" for r in rows),
              "pendingOrFailedPaths": sum(r["status"] != "technical_read_completed" for r in rows),
              "pages": sum(r.get("pageCount", 0) for r in rows), "readPages": sum(r["readPages"] for r in rows),
              "failedPages": sum(r["failedPages"] for r in rows), "textLayerPages": sum(r["textLayerPages"] for r in rows),
              "noCharacterObjectPages": sum(r["noCharacterObjectPages"] for r in rows),
              "reusedCoordinatePages": sum(bool(p.get("coordinateEvidence", {}).get("reused")) for r in rows for p in r["pages"]),
              "freshExtractionRequiredForReuse": True,
              "rangeMappedCharacters": sum(p.get("rangeMappedCharacters", 0) for r in rows for p in r["pages"]),
              "rangeUnmappedCharacters": sum(p.get("rangeUnmappedCharacters", 0) for r in rows for p in r["pages"]),
              "boundedMappedCharacters": sum(p.get("boundedMappedCharacters", 0) for r in rows for p in r["pages"]),
              "boundedUnmappedPages": sum(p.get("boundedMappingStatus") == "unmapped_different_api_view" for r in rows for p in r["pages"]),
              "rows": rows, "representativeRenders": rendered, "realArkCalls": 0,
              "ocrPerformed": False, "rolesPromoted": False, "formatIngestionPromoted": False,
              "originalDenominatorChanged": False, "originalFilesModified": False,
              "dependencies": {"python": sys.version, "pdfplumber": pdfplumber.__version__, "pypdf": pypdf.__version__, "pdfium": str(pypdfium2.PDFIUM_INFO)},
              "scope": "Every page's technical text/coordinate availability only. Text presence does not prove legibility, complete content, OCR accuracy, manuscript role or readiness for review."}
    write_json(output / "report.json", report)
    print(json.dumps({k: report[k] for k in ["selectedPdfPaths", "technicalCompletedPaths", "pages", "readPages", "failedPages", "textLayerPages", "noCharacterObjectPages", "realArkCalls"]}))
    return 0 if report["pendingOrFailedPaths"] == 0 else 1

if __name__ == "__main__":
    raise SystemExit(main())
