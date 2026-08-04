from pathlib import Path
import re
import zipfile

p = Path(r'C:\Users\PAVILION RYZEN 7\Desktop\Y4 S1\Project A\VINSCOPE KENYA\PROJECT A PROPOSAL VINSCOPE KENYA.docx')
print('exists=', p.exists())
if not p.exists():
    raise SystemExit(0)

with zipfile.ZipFile(p) as z:
    xml = z.read('word/document.xml').decode('utf-8', errors='ignore')

text = re.sub(r'<[^>]+>', '\n', xml)
text = re.sub(r'\s+', ' ', text).strip()
print(text[:20000])
