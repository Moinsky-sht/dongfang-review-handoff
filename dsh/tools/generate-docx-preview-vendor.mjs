/** Deterministic, local-only vendor generation. Never changes node_modules or installs packages. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const VENDOR=join(ROOT,'public/vendor');
const sha=b=>createHash('sha256').update(b).digest('hex');
const VERSION='0.4.0';
const BASE_SHA='48206d7d7ab55fcdf50e5a47aff0bd15734b3da6dd30e0b46e47ca172d0e16fc';
const MAP_SHA='77e287027ddc46e9c05476b4d050519b1a2c9dd0bf5f538e8612401ffd8d6b17';
const LICENSE_SHA='8668bf4417d161e4eb4d47d6044526e4914d9eb3c748573d9bb7e87708c1253f';
const oldLine='                children = [this.h({ tagName: elem.verticalAlign, children: this.renderElements(elem.children) })];';
const newLine='                children = [this.h({ tagName: elem.verticalAlign, children })]; // DSH modified: render each run child once.';
const installed=join(ROOT,'node_modules/docx-preview');
const installedExists=existsSync(join(installed,'dist/docx-preview.js'));
if(installedExists)assert.equal(JSON.parse(readFileSync(join(installed,'package.json'),'utf8')).version,VERSION,'Installed package version drift');
const source=readFileSync(installedExists?join(installed,'dist/docx-preview.js'):join(VENDOR,'upstream/docx-preview-0.4.0.js'));
const sourceMap=readFileSync(installedExists?join(installed,'dist/docx-preview.js.map'):join(VENDOR,'upstream/docx-preview.js.map'));
const license=readFileSync(installedExists?join(installed,'LICENSE'):join(VENDOR,'docx-preview-0.4.0.LICENSE.txt'));
assert.equal(sha(source),BASE_SHA,'Original upstream bundle SHA drift');
assert.equal(sha(sourceMap),MAP_SHA,'Original upstream map SHA drift');
assert.equal(sha(license),LICENSE_SHA,'Original upstream license SHA drift');
const sourceText=source.toString('utf8');
assert.equal(sourceText.split(oldLine).length-1,1,'Patch must match exactly once');
const hit=sourceText.indexOf(oldLine),methodStart=sourceText.lastIndexOf('        renderRun(elem) {',hit),methodEnd=sourceText.indexOf('\n        }',methodStart);
assert(methodStart>=0&&hit>methodStart&&hit<methodEnd,'The unique hit must belong to renderRun');
const generatedLine=sourceText.slice(0,hit).split('\n').length;
const identityMethod = `        // DSH modified: physical identities come only from real WML XML nodes.
        dshSourceXmlIdentity(node, localName) {
            const uri = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
            const doc = node?.ownerDocument;
            if (!doc || node.namespaceURI !== uri || node.localName !== localName)
                return {};
            const roots = { document: "document.xml", footnotes: "footnotes.xml", endnotes: "endnotes.xml" };
            const root = doc.documentElement;
            const part = root?.namespaceURI === uri && roots[root.localName];
            if (!part)
                return {};
            this.dshXmlIdentityCache ??= new WeakMap();
            let byType = this.dshXmlIdentityCache.get(doc);
            if (!byType) {
                byType = new Map();
                this.dshXmlIdentityCache.set(doc, byType);
            }
            if (!byType.has(localName))
                byType.set(localName, new Map(Array.from(doc.getElementsByTagNameNS(uri, localName), (element, ordinal) => [element, ordinal])));
            const ordinal = byType.get(localName).get(node);
            if (!Number.isInteger(ordinal))
                return {};
            if (localName === "tab" || localName === "noBreakHyphen")
                return { part, sourceXmlCharacterOrdinal: ordinal, sourceXmlCharacterNodeId: part + ":xml-" + localName + ":" + ordinal };
            return localName === "p"
                ? { part, sourceXmlParagraphOrdinal: ordinal, sourceXmlNodeId: part + ":xml-p:" + ordinal }
                : { part, sourceXmlTableOrdinal: ordinal, sourceXmlNodeId: part + ":xml-tbl:" + ordinal };
        }
        // DSH modified: bind special display characters to their actual XML node.
        dshSourceCharacter(node, kind) {
            if (kind !== "tab" && kind !== "noBreakHyphen")
                return {};
            const character = this.dshSourceXmlIdentity(node, kind);
            let paragraph = node?.parentNode;
            const uri = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
            while (paragraph && !(paragraph.namespaceURI === uri && paragraph.localName === "p"))
                paragraph = paragraph.parentNode;
            const owner = this.dshSourceXmlIdentity(paragraph, "p");
            if (!character.sourceXmlCharacterNodeId || !owner.sourceXmlNodeId || owner.part !== character.part)
                return {};
            return { schemaVersion: 1, kind, part: owner.part,
                paragraphNodeId: owner.sourceXmlNodeId, sourceXmlParagraphOrdinal: owner.sourceXmlParagraphOrdinal,
                characterNodeId: character.sourceXmlCharacterNodeId, sourceXmlCharacterOrdinal: character.sourceXmlCharacterOrdinal,
                rawText: kind === "tab" ? "\\t" : "-", displayText: kind === "tab" ? "\\u2003" : "\\u2011",
                textView: "after", offsetUnit: "utf16" };
        }
`;
const identityPatches = [
  {method:'DocumentParser.dshSourceXmlIdentity',old:'        parseNotes(xmlDoc, elemName, elemClass) {',next:identityMethod+'        parseNotes(xmlDoc, elemName, elemClass) {'},
  {method:'DocumentParser.parseParagraph',old:'        parseParagraph(node) {\n            var result = { type: DomType.Paragraph, children: [] };',next:'        parseParagraph(node) {\n            var result = { type: DomType.Paragraph, children: [] };\n            Object.assign(result, this.dshSourceXmlIdentity(node, "p")); // DSH physical XML identity.'},
  {method:'DocumentParser.parseTable',old:'        parseTable(node) {\n            var result = { type: DomType.Table, children: [] };',next:'        parseTable(node) {\n            var result = { type: DomType.Table, children: [] };\n            Object.assign(result, this.dshSourceXmlIdentity(node, "tbl")); // DSH physical XML identity.'},
];
const characterPatches = [
  {method:'DocumentParser.parseRun.Tab',old:'                        result.children.push({ type: DomType.Tab });',next:'                        result.children.push({ type: DomType.Tab, dshSourceCharacter: this.dshSourceCharacter(c, "tab") }); // DSH actual XML character identity.'},
  {method:'DocumentParser.parseRun.NoBreakHyphen',old:'                        result.children.push({ type: DomType.NoBreakHyphen });',next:'                        result.children.push({ type: DomType.NoBreakHyphen, dshSourceCharacter: this.dshSourceCharacter(c, "noBreakHyphen") }); // DSH actual XML character identity.'},
  {method:'HtmlRenderer.renderTab',old:'            var tabSpan = this.h({ tagName: "span", children: ["\\u2003"] });',next:'            var tabSpan = this.h({ tagName: "span", className: elem.className, children: ["\\u2003"] }); // DSH retain source character annotation.'},
  {method:'HtmlRenderer.renderTab.experimental',old:'                tabSpan.className = this.tabStopClass();',next:'                tabSpan.className = cx(tabSpan.className, this.tabStopClass()); // DSH retain annotation and tab-stop styling.'},
  {method:'HtmlRenderer.renderElement.NoBreakHyphen',old:'                    return this.h({ tagName: "wbr" });',next:'                    return this.h({ tagName: "span", className: elem.className, children: ["\\u2011"] }); // DSH render the actual nonbreaking hyphen, not a word-break hint.'},
];
const allPatches=[...identityPatches,...characterPatches];
let patchedText=sourceText.replace(oldLine,newLine);
for(const p of allPatches){assert.equal(patchedText.split(p.old).length-1,1,'Local patch must match exactly once: '+p.method);p.originalLine=sourceText.slice(0,sourceText.indexOf(p.old)).split('\n').length;patchedText=patchedText.replace(p.old,p.next);}
for(const p of allPatches)p.generatedLine=patchedText.slice(0,patchedText.indexOf(p.next)).split('\n').length;
const patched=Buffer.from(patchedText);

// Decode and re-encode v3 mappings so removed expression columns cannot point beyond
// the shortened line. Other generated lines and all original source coordinates stay exact.
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decodeMapping(mappings){
  let src=0,srcLine=0,srcCol=0,name=0;
  return mappings.split(';').map(line=>{let col=0;return line?line.split(',').map(segment=>{const vals=[];let value=0,shift=0;for(const c of segment){const n=alphabet.indexOf(c);assert(n>=0);value+=(n&31)*2**shift;if(n&32)shift+=5;else{vals.push(value&1?-(value>>1):value>>1);value=0;shift=0;}}assert.equal(shift,0);col+=vals[0];const out=[col];if(vals.length>1){assert(vals.length===4||vals.length===5);src+=vals[1];srcLine+=vals[2];srcCol+=vals[3];out.push(src,srcLine,srcCol);if(vals.length===5){name+=vals[4];out.push(name);}}return out;}):[];});
}
function vlq(n){let value=n<0?(-n)*2+1:n*2,result='';do{let digit=value&31;value=Math.floor(value/32);if(value)digit|=32;result+=alphabet[digit];}while(value);return result;}
function encodeMapping(lines){let src=0,srcLine=0,srcCol=0,name=0;return lines.map(line=>{let col=0;return line.map(s=>{const v=[s[0]-col];col=s[0];if(s.length>1){v.push(s[1]-src,s[2]-srcLine,s[3]-srcCol);[src,srcLine,srcCol]=s.slice(1,4);if(s.length===5){v.push(s[4]-name);name=s[4];}}return v.map(vlq).join('');}).join(',');}).join(';');}
const map=JSON.parse(sourceMap);
const mappings=decodeMapping(map.mappings);
const removed=': this.renderElements(elem.children)';
const removalStart=oldLine.indexOf(removed),removalEnd=removalStart+removed.length;
assert(removalStart>=0);
const oldLineMappings=mappings[generatedLine-1];
mappings[generatedLine-1]=oldLineMappings.filter(s=>s[0]<removalStart||s[0]>=removalEnd).map(s=>s[0]>=removalEnd?[s[0]-removed.length,...s.slice(1)]:s);
assert(mappings[generatedLine-1].every(s=>s[0]<newLine.indexOf('//')),JSON.stringify({generatedLine,oldLineMappings,newMappings:mappings[generatedLine-1],commentColumn:newLine.indexOf('//'),removalStart,removalEnd}));
// Added local code has no upstream mapping. Shift unchanged generated lines while
// retaining their exact original coordinates. Apply bottom-up at original lines.
for(const p of [...allPatches].sort((a,b)=>b.originalLine-a.originalLine)){
  const added=p.next.split('\n').length-p.old.split('\n').length;
  if (added === 0) { for(let line=0;line<p.old.split('\n').length;line++)mappings[p.originalLine-1+line]=[];continue; }
  const insertAt=p.method.endsWith('dshSourceXmlIdentity')?p.originalLine-1:p.originalLine+1;
  mappings.splice(insertAt,0,...Array.from({length:added},()=>[]));
}
const patchedMap=Buffer.from(JSON.stringify({...map,file:'docx-preview-0.4.0.js',mappings:encodeMapping(mappings)})+'\n');
assert.deepEqual(decodeMapping(JSON.parse(patchedMap).mappings),mappings,'Source map coordinate round trip');
const provenance={schemaVersion:1,generator:'tools/generate-docx-preview-vendor.mjs',generatorVersion:3,package:'docx-preview',version:VERSION,license:'Apache-2.0',repository:'https://github.com/VolodymyrBaydalka/docxjs',upstream:{bundle:'upstream/docx-preview-0.4.0.js',bundleSha256:BASE_SHA,sourceMap:'upstream/docx-preview.js.map',sourceMapSha256:MAP_SHA,licenseSha256:LICENSE_SHA},output:{bundle:'docx-preview-0.4.0.js',bundleSha256:sha(patched),sourceMap:'docx-preview.js.map',sourceMapSha256:sha(patchedMap)},patch:{method:'HtmlRenderer.renderRun',generatedLine,uniqueMatches:1,oldLine,newLine,reason:'Render run children once. The original verticalAlign branch rendered them a second time, duplicating note-reference and other child side effects.'},identityPatches:identityPatches.map(p=>({...p,uniqueMatches:1,reason:'Add actual WML XML paragraph/table identity. Fake change wrappers, unknown parts and namespaces never receive an identity; XML node order includes textbox nodes without merging their business ownership.'})),characterPatches:characterPatches.map(p=>({...p,uniqueMatches:1,reason:'Actual XML character identities and displayed TAB/nonbreaking-hyphen projection. Do not infer ownership from the displayed glyph.'})),sourceMap:{change:'Changed local expression lines have no upstream mappings. Inserted identity methods have no upstream mapping; unchanged generated lines retain exact upstream source coordinates after their line shift.'},notice:'The modified bundle carries inline DSH modification notices. Original copyright and complete Apache-2.0 license are retained.'};
const diff=['--- upstream/docx-preview-0.4.0.js','+++ docx-preview-0.4.0.js',...allPatches.flatMap(p=>[`@@ -${p.originalLine},${p.old.split('\n').length} +${p.generatedLine},${p.next.split('\n').length} @@`,...p.old.split('\n').map(l=>'-'+l),...p.next.split('\n').map(l=>'+'+l)]),`@@ -${generatedLine-1},3 +${patchedText.slice(0,patchedText.indexOf(newLine)).split('\n').length-1},3 @@`,'             if (elem.verticalAlign) {','-'+oldLine,'+'+newLine,'             }',''].join('\n');
const readme=['# Managed docx-preview 0.4.0','',
  'This local copy preserves the installed Apache-2.0 renderer. HtmlRenderer.renderRun reuses children already rendered once; ordinary run formatting and the outer sup/sub container are retained. Note references register once per source occurrence, including repeated references to the same note ID.','',
  'DocumentParser additionally carries actual WML paragraph and table XML ordinals into its fresh AST. It counts all physical nodes in each actual XML part, including textbox nodes, and does not assign identities to ins/del/sdt wrappers or unsupported parts. App binding separately proves package SHA, version, session, workspace, activation and complete rendered text. Identity metadata does not modify source bytes, text, styles or rendering.','',
  'Actual XML tab and noBreakHyphen nodes additionally carry independent physical character and paragraph-owner identities. TAB retains its renderer em-space and tab-stop class. noBreakHyphen displays U+2011 instead of the upstream empty word-break hint; source logical text remains hyphen-minus. App validates authoritative source ranges and reverses only proved glyph projections; ordinary Unicode text never acquires a projection.','',
  'The exact upstream bundle and source map are archived under upstream/. The original copyright banner and full license are retained. provenance.json pins every input and output SHA and explains the source map adjustment. The modified bundle has an inline DSH modification notice.','',
  'Rebuild locally: node tools/generate-docx-preview-vendor.mjs','Verify without writing: node tools/generate-docx-preview-vendor.mjs --check','The generator accepts only the pinned 0.4.0 bytes; it can rebuild from the archived inputs if the installed package is absent. It never changes node_modules or downloads a package.','',
  'Software regression: node tools/test-docx-preview-renderer.mjs','Original failure proof: node tools/test-docx-preview-renderer.mjs --source=original','These VM checks use complete actual renderer methods with an explicit DOM substitute. Browser layout and Word application behavior require their own evidence.',''].join('\n');
const outputs=new Map([['docx-preview-0.4.0.js',patched],['docx-preview.js.map',patchedMap],['docx-preview-0.4.0.LICENSE.txt',license],['upstream/docx-preview-0.4.0.js',source],['upstream/docx-preview.js.map',sourceMap],['provenance.json',Buffer.from(JSON.stringify(provenance,null,2)+'\n')],['docx-preview-single-pass.diff',Buffer.from(diff)],['README.md',Buffer.from(readme)]]);
function guard(p){for(let a=p;a!==dirname(a);a=dirname(a))if(existsSync(a))assert(!lstatSync(a).isSymbolicLink()&&resolve(realpathSync(a)).toLowerCase()===resolve(a).toLowerCase(),'Vendor alias rejected: '+a);}
for(const [name,bytes] of outputs){const p=join(VENDOR,name);guard(p);if(process.argv.includes('--check'))assert(existsSync(p)&&readFileSync(p).equals(bytes),'Vendor output drift: '+name);else{mkdirSync(dirname(p),{recursive:true});guard(p);writeFileSync(p,bytes);} }
assert.equal(sha(source),BASE_SHA);
if(installedExists)assert.equal(sha(readFileSync(join(installed,'dist/docx-preview.js'))),BASE_SHA,'Installed component changed');
console.log(JSON.stringify({ok:true,mode:process.argv.includes('--check')?'check':'generate',version:VERSION,baseSha256:BASE_SHA,vendorSha256:sha(patched),sourceMapSha256:sha(patchedMap),patches:1+allPatches.length,uniqueMatches:1,outputs:[...outputs.keys()]}));
