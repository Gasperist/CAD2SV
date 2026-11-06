#!/usr/bin/env python3
"""Erzeugt test/testplan.pdf: A3-Vektorplan im Maßstab 1:100 mit bekannten Maßen.
Saal 30 x 20 m, Bühne 10 x 5 m, Kreis r = 4 m; Seite 2 ist ein Schnitt mit Tribüne (0 -> 3 m auf 8 m)."""
import os, math
K = 72 / 0.0254 / 100  # Punkte pro Meter bei 1:100
def plan():
    x0, y0 = 100, 80; s = []
    def rect(x, y, w, h): s.append(f"{x0+x*K:.3f} {y0+y*K:.3f} {w*K:.3f} {h*K:.3f} re S")
    s.append("0.8 w 0 0 0 RG"); rect(0, 0, 30, 20); rect(10, 15, 10, 5)
    cx, cy, r = x0+15*K, y0+7*K, 4*K; c = .5523*r
    s.append(f"{cx+r:.3f} {cy:.3f} m {cx+r:.3f} {cy+c:.3f} {cx+c:.3f} {cy+r:.3f} {cx:.3f} {cy+r:.3f} c {cx-c:.3f} {cy+r:.3f} {cx-r:.3f} {cy+c:.3f} {cx-r:.3f} {cy:.3f} c {cx-r:.3f} {cy-c:.3f} {cx-c:.3f} {cy-r:.3f} {cx:.3f} {cy-r:.3f} c {cx+c:.3f} {cy-r:.3f} {cx+r:.3f} {cy-c:.3f} {cx+r:.3f} {cy:.3f} c S")
    return "\n".join(s)
def schnitt():
    x0, y0 = 100, 200; p = [(0,0),(22,0),(30,3),(30,10),(0,10)]
    pts = [f"{x0+x*K:.3f} {y0+z*K:.3f}" for x,z in p]
    return "0.8 w 0 0 0 RG\n" + pts[0] + " m " + " l ".join(pts[1:]) + " l h S"
pages = [plan(), schnitt()]
W, H = 1191, 842; objs = {}
kids = " ".join(f"{3+2*i} 0 R" for i in range(len(pages)))
objs[1] = "<< /Type /Catalog /Pages 2 0 R >>"
objs[2] = f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>"
for i, c in enumerate(pages):
    objs[3+2*i] = f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {W} {H}] /Contents {4+2*i} 0 R >>"
    objs[4+2*i] = f"<< /Length {len(c)} >>\nstream\n{c}\nendstream"
out = "%PDF-1.4\n"; off = {}
for n in sorted(objs):
    off[n] = len(out); out += f"{n} 0 obj\n{objs[n]}\nendobj\n"
x = len(out); out += f"xref\n0 {len(objs)+1}\n0000000000 65535 f \n" + "".join(f"{off[n]:010d} 00000 n \n" for n in sorted(objs))
out += f"trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF\n"
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "testplan.pdf"), "w").write(out)
