#!/usr/bin/env python3
"""Build a safe, self-contained reading view from project Markdown."""
from __future__ import annotations

import html
import os
import re
from pathlib import Path


def inline(text: str) -> str:
  value = html.escape(text, quote=True)
  value = re.sub(r"`([^`]+)`", r"<code>\1</code>", value)
  value = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", value)
  value = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", value)

  def link(match: re.Match[str]) -> str:
    label, href = match.groups()
    safe = href if re.match(r"^(https?://|#|mailto:)", href, re.I) else "#"
    return f'<a href="{html.escape(safe, quote=True)}">{label}</a>'

  return re.sub(r"\[([^]]+)]\(([^)]+)\)", link, value)


def markdown(source: str) -> str:
  blocks: list[str] = []
  paragraph: list[str] = []
  list_items: list[str] = []

  def flush_paragraph() -> None:
    if paragraph:
      blocks.append(f"<p>{inline(' '.join(paragraph))}</p>")
      paragraph.clear()

  def flush_list() -> None:
    if list_items:
      blocks.append("<ul>" + "".join(f"<li>{inline(item)}</li>" for item in list_items) + "</ul>")
      list_items.clear()

  for raw in source.splitlines():
    line = raw.rstrip()
    if not line:
      flush_paragraph(); flush_list(); continue
    heading = re.match(r"^(#{1,4})\s+(.+)$", line)
    if heading:
      flush_paragraph(); flush_list()
      level = len(heading.group(1))
      blocks.append(f"<h{level}>{inline(heading.group(2))}</h{level}>")
    elif line.startswith("- "):
      flush_paragraph(); list_items.append(line[2:])
    elif line.startswith("> "):
      flush_paragraph(); flush_list(); blocks.append(f"<blockquote>{inline(line[2:])}</blockquote>")
    elif re.fullmatch(r"-{3,}", line):
      flush_paragraph(); flush_list(); blocks.append("<hr>")
    else:
      flush_list(); paragraph.append(line)
  flush_paragraph(); flush_list()
  return "\n".join(blocks)


root = Path(os.environ["PROJECT_ROOT"]).resolve()
source = (root / os.environ["PROJECT_SOURCE"]).resolve()
output = Path(os.environ["PROJECT_OUTPUT_DIR"]).resolve()
if root not in source.parents:
  raise SystemExit("Document source must stay inside the project root.")
output.mkdir(parents=True, exist_ok=True)
body = markdown(source.read_text(encoding="utf-8"))
(output / "index.html").write_text(f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(source.stem)}</title><style>
:root{{font:17px/1.72 Georgia,serif;color:#242420;background:#ece9e1;--accent:#9c3c2c}}*{{box-sizing:border-box}}body{{margin:0;padding:clamp(12px,5vw,70px)}}article{{max-width:780px;margin:auto;background:#fffef9;padding:clamp(32px,8vw,92px);box-shadow:0 24px 90px #312d2217;border-top:6px solid var(--accent)}}h1{{font-size:clamp(2.5rem,8vw,5rem);line-height:.98;letter-spacing:-.05em;margin:.1em 0 .5em;font-weight:500}}h2,h3,h4{{font-family:ui-sans-serif,system-ui,sans-serif;margin:2.4em 0 .7em;letter-spacing:-.02em}}h2{{color:var(--accent);font-size:1rem;text-transform:uppercase;letter-spacing:.1em}}p,ul{{margin:0 0 1.1em}}ul{{padding-left:1.2em}}blockquote{{margin:2em -1.5em;padding:1.25em 1.5em;background:#f5f1e8;border-left:3px solid var(--accent);font-size:1.08rem}}code{{padding:.15em .35em;border-radius:.3em;background:#f0ece3;font:80% ui-monospace,monospace}}a{{color:var(--accent)}}hr{{margin:3em 0;border:0;border-top:1px solid #dedbd1}}@media(max-width:600px){{article{{padding:30px 24px}}blockquote{{margin:1.6em 0}}}}
</style></head><body><article>{body}</article></body></html>""", encoding="utf-8")
