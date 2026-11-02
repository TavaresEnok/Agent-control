from pathlib import Path
import csv,re,json
root=Path(__file__).resolve().parent.parent
text=(root/'docs/normative/DIRETRIZ_MESTRE_V1.md').read_text()
rows={}
partial={'RF-01','RF-02','RF-03','RF-04','RF-15','RF-22','RF-23','RF-24','RF-28','RF-31','RF-36','RF-44','RF-45','RF-50','RF-53','RNF-01','RNF-02','RNF-06','RNF-08','RNF-09','T06','T07','T08','T19','T27','T36'}
for line in text.splitlines():
 if not re.match(r'^(RF-\d{2}|RNF-\d{2}|T\d{2})\t',line):continue
 parts=line.split('\t');id=parts[0]
 rows[id]={'id':id,'normative_row':line,'status':'partially_examined' if id in partial else 'future_phase','code_state':'partial' if id in partial else 'not_implemented','test_result':'partial_scope_only' if id in partial else 'not_run','evidence':'docs/validation/evidence/; ACCEPTANCE-I0-I2.md' if id in partial else '', 'files':'src/ledger.ts;src/cezar.ts;src/happier.ts;src/api.ts;tests/' if id in partial else '', 'independent_review':'pending','authorization':'isolated_synthetic_only','acceptance':'not_accepted','limitation':'A partial test does not approve the full requirement or acceptance scenario.'}
assert len([k for k in rows if k.startswith('RF-')])==57
assert len([k for k in rows if k.startswith('RNF-')])==15
assert len([k for k in rows if k.startswith('T')])==39
(root/'docs/validation/TRACEABILITY.json').write_text(json.dumps(list(rows.values()),ensure_ascii=False,indent=2)+'\n')
with (root/'docs/validation/TRACEABILITY.csv').open('w') as f:
 w=csv.DictWriter(f,fieldnames=list(next(iter(rows.values())).keys()));w.writeheader();w.writerows(rows.values())
print('57 RF + 15 RNF + 39 T =',len(rows),'requirements tracked; no full-scope acceptance inferred')
