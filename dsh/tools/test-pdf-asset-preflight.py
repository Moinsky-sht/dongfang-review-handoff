"""Engineering fixtures for PDF provenance, explicit pending states and output guards."""
import argparse
import importlib.util
import io
import json
from pathlib import Path
import uuid
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
from PIL import Image

MODULE_PATH=Path(__file__).absolute().with_name("preflight-pdf-assets.py")
spec=importlib.util.spec_from_file_location("pdf_asset_preflight",MODULE_PATH)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

def main():
    parser=argparse.ArgumentParser();parser.add_argument("--out-dir",required=True);args=parser.parse_args()
    out=module.guarded_output(Path(args.out_dir),create=True)
    fixtures=out/"fixtures";fixtures.mkdir()
    checks=[]
    def check(name,condition):
        if not condition:raise AssertionError(name)
        checks.append({"name":name,"ok":True})
    def refuse(name,operation):
        try:operation()
        except (ValueError,FileExistsError):check(name,True)
        else:raise AssertionError(name)
    # Generated files are software-only fixtures, not original corpus assets.
    buffer=io.BytesIO();page=canvas.Canvas(buffer,pagesize=(200,300));page.drawString(20,270,"Software ABC 123");page.showPage()
    picture=Image.new("RGB",(40,30),(100,160,210));page.drawInlineImage(picture,20,150,width=100,height=75);page.showPage();page.save()
    mixed=fixtures/"mixed.pdf";mixed.write_bytes(buffer.getvalue())
    a={"assetId":"software-mixed","relativePath":"mixed.pdf","sourceSha256":module.sha(mixed.read_bytes())}
    row=module.inspect_pdf(mixed,a,out)
    check("Both independent page counts cover text and image-only pages",row["status"]=="technical_read_completed" and row["pageCount"]==2 and row["independentPageCountAgreement"])
    check("Text and image-only availability have separate pending OCR states",row["textLayerPages"]==1 and row["noCharacterObjectPages"]==1 and all(p["ocrDisposition"]=="pending_visual_and_ocr_validation" for p in row["pages"]))
    check("Image objects remain visible in technical evidence",row["pages"][1]["imageObjectCount"]==1)
    coord=json.loads((module.PROJECT/row["pages"][0]["coordinateEvidence"]["path"]).read_text(encoding="utf-8"))
    check("Character and text indices have explicit distinct API owners",coord["characterRowFields"]==["charIndex","rawUnicodeApiValue","rangeUtf16TextIndex","isGenerated","canvasBox"] and "FPDFText_GetText full-range UTF-16" in coord["rangeIndexOwner"] and all(len(c)==5 for c in coord["characters"]))
    supplementary=module.range_view([0xD835,0xDC3F,65],chr(119871)+"A",[[0,0xD835,0,0,[]],[1,0xDC3F,1,0,[]],[2,65,2,0,[]]])
    check("Surrogate units share one proven Python scalar span",supplementary["rangePythonOffsets"]==[[0,1],[0,1],[1,2]] and supplementary["boundedMapping"]["useRangeOffsets"])
    cropped=module.range_view([65,13,10,66],"AB",[[0,65,0,0,[]],[1,66,3,0,[]]])
    check("Different newline or crop view cannot reuse full-range offsets",cropped["rangePythonOffsets"]==[[0,1],[3,4]] and cropped["boundedMapping"]["status"]=="unmapped_different_api_view" and cropped["boundedMapping"]["mappedCharacters"]==0)
    unresolved=module.range_view([65],"A",[[0,66,0,0,[]],[1,65,4,0,[]],[2,65,-1,0,[]]])
    check("Disagreeing, out-of-range and excluded API values stay unmapped",unresolved["rangePythonOffsets"]==[None,None,None] and len(unresolved["rangeMappingFailures"])==3)
    check("Every internal character has its original ordinal and finite box",[c[0] for c in coord["characters"]]==list(range(len(coord["characters"]))) and all(c[4] is not None for c in coord["characters"]))
    check("Text availability cannot promote role, format intake or quality",not row["intakeReady"] and not row["qualityStagePassed"] and row["role"]=="unclassified")
    reuse_dir=out/"fresh-reuse";module.guarded_output(reuse_dir,create=True)
    reused=module.inspect_pdf(mixed,a,reuse_dir,{p["pageIndex"]:p["coordinateEvidence"] for p in row["pages"]})
    check("Reuse freshly extracts every page and compares exact bytes",reused["status"]=="technical_read_completed" and all(p["coordinateEvidence"].get("validatedByFreshExtraction") for p in reused["pages"]))
    check("Identical coordinate evidence is referenced without duplicate payload files",not list((reuse_dir/a["assetId"]).glob("page-*.json")))
    refuse("Corrupt coordinate identity refuses instead of trusting prior report",lambda:module.coordinate_evidence(out/"untrusted-coordinate.json",coord,{**row["pages"][0]["coordinateEvidence"],"sha256":"0"*64}))
    refuse("Coordinate reuse outside run roots refuses",lambda:module.coordinate_evidence(out/"outside-coordinate.json",coord,{"path":"tools/preflight-pdf-assets.py","sha256":"0"*64,"bytes":1}))
    writer=PdfWriter();reader=PdfReader(mixed);writer.add_page(reader.pages[0]);writer.encrypt("fixture-only-user-password")
    locked=fixtures/"password-required.pdf"
    with locked.open("xb") as stream:writer.write(stream)
    locked_row=module.inspect_pdf(locked,{"assetId":"software-locked","relativePath":locked.name,"sourceSha256":module.sha(locked.read_bytes())},out)
    check("Non-empty password remains explicit pending without guessing",locked_row["status"]=="password_required_not_processed" and not locked_row["defaultEmptyPasswordRead"] and locked_row["readPages"]==0)
    damaged=fixtures/"damaged.pdf";damaged.write_bytes(b"%PDF-1.7\nnot-a-valid-object-tree")
    bad=module.inspect_pdf(damaged,{"assetId":"software-damaged","relativePath":damaged.name,"sourceSha256":module.sha(damaged.read_bytes())},out)
    check("Damaged PDF keeps exact source hash and explicit failure",bad["status"]=="technical_read_failed" and bad["sourceHashAfter"]==bad["sourceSha256"] and bool(bad["errors"]))
    mismatch=out/"software-mismatch"
    refuse("Inventory hash mismatch refuses before making output",lambda:module.inspect_pdf(mixed,{**a,"assetId":"software-mismatch","sourceSha256":"0"*64},out))
    check("Hash refusal writes no derivative",not mismatch.exists())
    refuse("Replaying output refuses instead of replacing evidence",lambda:module.inspect_pdf(mixed,a,out))
    refuse("Outside evidence root refuses",lambda:module.guarded_output(module.PROJECT/"tmp"/f"outside-pdf-{uuid.uuid4()}",create=True))
    blocked=out/"sealed-negative";blocked.mkdir();(blocked/"complete.json").write_text("{}",encoding="utf-8")
    refuse("Sealed ancestor refuses before creating descendants",lambda:module.guarded_output(blocked/"child",create=True))
    check("Sealed refusal leaves no child directory",not (blocked/"child").exists())
    refusal_path=out/"finite-values.json"
    refuse("Non-finite coordinate JSON refuses before creating a file",lambda:module.write_json(refusal_path,{"box":[float("nan")]}))
    check("Non-finite refusal leaves no file",not refusal_path.exists())
    check("All original software fixture bytes stay unchanged",module.sha(mixed.read_bytes())==a["sourceSha256"])
    module.write_json(out/"report.json",{"softwareOnly":True,"originalCorpusAssetsIncluded":0,"realArkCalls":0,"toolSha256":module.sha(MODULE_PATH.read_bytes()),"passed":len(checks),"checks":checks})
    print(json.dumps({"passed":len(checks),"failed":0,"realArkCalls":0}))

if __name__=="__main__":main()
