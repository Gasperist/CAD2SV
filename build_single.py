#!/usr/bin/env python3
"""Packt das Tool in eine einzige Datei: dist/CAD2SV.html (inklusive pdf.js, läuft offline).
Aufruf: python3 build_single.py            -> vollständiges HTML zum Doppelklicken
        python3 build_single.py --fragment -> nur der Seiteninhalt (für das Artifact)"""
import os
import re
import sys

root = os.path.dirname(os.path.abspath(__file__))


def read(name):
    with open(os.path.join(root, name), encoding="utf8") as f:
        return f.read()


def script(code):
    # Darf den umgebenden script-Block nicht vorzeitig beenden.
    safe = code.replace("</script", "<\\/script").replace("<!--", "<\\!--")
    return "<script>\n" + safe + "\n</script>"


html = read("index.html")
css = read("style.css")
body = re.search(r"<body>(.*)</body>", html, re.S).group(1)
# PDFJS_SOURCES-Block entfällt: die Bibliothek ist eingebettet.
body = re.sub(r"<script>\s*/\* pdf\.js zuerst.*?</script>\s*", "", body, flags=re.S)
scripts = "\n".join(script(read(n)) for n in ("vendor/pdf.min.js", "vendor/pdf.worker.min.js", "app.js"))
body = body.replace('<script src="app.js"></script>', "@@SCRIPTS@@").replace("@@SCRIPTS@@", scripts)

os.makedirs(os.path.join(root, "dist"), exist_ok=True)
if "--fragment" in sys.argv:
    page = "<title>CAD2SV</title>\n<style>\n" + css + "\nhtml,body{height:100%}\n</style>\n" + body
    out = "dist/fragment.html"
else:
    page = ('<!doctype html>\n<html lang="de">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            "<title>CAD2SV</title>\n<style>\n" + css + "\n</style>\n</head>\n<body>" + body + "</body>\n</html>\n")
    out = "dist/CAD2SV.html"
with open(os.path.join(root, out), "w", encoding="utf8") as f:
    f.write(page)
print(out, round(len(page.encode("utf8")) / 1024), "KB")
