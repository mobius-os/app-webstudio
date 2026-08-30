#!/usr/bin/env python3
"""Build a responsive, self-contained data view from a project CSV."""
from __future__ import annotations

import csv
import html
import json
import os
from pathlib import Path

root = Path(os.environ["PROJECT_ROOT"]).resolve()
source = (root / os.environ["PROJECT_SOURCE"]).resolve()
output = Path(os.environ["PROJECT_OUTPUT_DIR"]).resolve()
if root not in source.parents:
  raise SystemExit("Spreadsheet source must stay inside the project root.")
with source.open(newline="", encoding="utf-8-sig") as handle:
  rows = list(csv.reader(handle))
width = max((len(row) for row in rows), default=0)
rows = [row + [""] * (width - len(row)) for row in rows]
payload = json.dumps(rows, ensure_ascii=False).replace("</", "<\\/")
output.mkdir(parents=True, exist_ok=True)
(output / "index.html").write_text(f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(source.stem)}</title><style>
:root{{font:14px/1.45 ui-sans-serif,system-ui,sans-serif;color:#19211d;background:#eef0ec;--green:#2e7653;--line:#d8dcd7}}*{{box-sizing:border-box}}body{{margin:0;padding:clamp(16px,4vw,48px)}}main{{max-width:1080px;margin:auto}}header{{display:flex;justify-content:space-between;align-items:end;gap:24px;margin-bottom:24px}}.eyebrow{{margin:0;color:var(--green);font-weight:800;font-size:.7rem;letter-spacing:.14em;text-transform:uppercase}}h1{{margin:5px 0 0;font-size:clamp(2rem,6vw,3.4rem);letter-spacing:-.05em}}.summary{{text-align:right}}.summary span{{display:block;color:#747a75;font-size:.75rem}}.summary strong{{font-size:1.6rem;color:var(--green)}}.sheet{{overflow:auto;background:#fff;border:1px solid var(--line);border-radius:20px;box-shadow:0 16px 48px #26302a0c}}table{{width:100%;min-width:620px;border-collapse:collapse}}th,td{{border-bottom:1px solid var(--line);padding:13px 15px;text-align:left;white-space:nowrap}}th{{position:sticky;top:0;color:#737973;font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;background:#f8f9f6}}tbody tr:hover{{background:#f7f9f6}}tr:last-child td{{border:0}}.toolbar{{display:flex;align-items:center;gap:10px;margin-bottom:12px}}input{{min-height:40px;min-width:210px;flex:1;padding:0 12px;border:1px solid var(--line);border-radius:10px;background:#fff;color:inherit;font:inherit}}input:focus{{outline:2px solid #85b79c;outline-offset:1px}}.hint{{color:#737973;margin:14px 2px 0;font-size:.8rem}}@media(max-width:600px){{header{{align-items:start;flex-direction:column}}.summary{{text-align:left}}}}
</style></head><body><main><header><div><p class="eyebrow">Live dataset</p><h1>{html.escape(source.stem.replace('-', ' ').title())}</h1></div><div class="summary"><span>Visible rows</span><strong id="count">0</strong></div></header><div class="toolbar"><input id="filter" type="search" placeholder="Filter rows" aria-label="Filter rows"></div><section class="sheet"><table><thead id="head"></thead><tbody id="body"></tbody></table></section><p class="hint">Edit the CSV source in the project workspace to update this view.</p></main><script>
const rows={payload};const head=document.querySelector('#head'),body=document.querySelector('#body'),count=document.querySelector('#count'),filter=document.querySelector('#filter');const headers=rows[0]||[];head.innerHTML='<tr>'+headers.map(value=>`<th>${{escapeHtml(value)}}</th>`).join('')+'</tr>';function escapeHtml(value){{const el=document.createElement('span');el.textContent=value;return el.innerHTML}}function render(){{const term=filter.value.trim().toLowerCase();const visible=rows.slice(1).filter(row=>!term||row.some(value=>value.toLowerCase().includes(term)));body.innerHTML=visible.map(row=>'<tr>'+row.map(value=>`<td>${{escapeHtml(value)}}</td>`).join('')+'</tr>').join('');count.textContent=visible.length.toLocaleString()}}filter.addEventListener('input',render);render();
</script></body></html>""", encoding="utf-8")
