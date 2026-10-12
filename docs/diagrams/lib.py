"""Shared SVG primitives for the Fade spec diagrams.

Rule the whole file exists to enforce: geometry is computed from box sizes and
gaps, and text is painted after every box, so a label can never end up hidden
behind a shape. That defect is what the first hand-placed diagram shipped with.
"""
import html, pathlib, xml.dom.minidom

INK, MUTED = "#172b4d", "#5e6c84"
BLUE, BLUE_L = "#4C9AFF", "#DEEBFF"
GREEN, GREEN_L = "#57D9A3", "#E3FCEF"
RED, RED_L = "#FF8F73", "#FFEBE6"
YELL, YELL_L = "#FFC400", "#FFFAE6"
GREY, GREY_L = "#B3BAC5", "#F4F5F7"
PURP, PURP_L = "#998DD9", "#EAE6FF"
KINDS = {"blue": (BLUE_L, BLUE), "green": (GREEN_L, GREEN), "red": (RED_L, RED),
         "yellow": (YELL_L, YELL), "grey": (GREY_L, GREY), "purple": (PURP_L, PURP)}
FONT = "Segoe UI,Helvetica,Arial,sans-serif"

def esc(s): return html.escape(s, quote=False)

class Svg:
    def __init__(self, w, h):
        self.w, self.h, self.arrows, self.boxes, self.text = w, h, [], [], []
    def arrow(self, d, dashed=False, head=True):
        extra = ' stroke-dasharray="4 3"' if dashed else ""
        mk = "" if head else ' marker-end="none"'
        self.arrows.append(f'<path d="{d}"{extra}{mk}/>')
    def box(self, x, y, w, h, kind="blue", rx=8, dashed=False):
        fill, stroke = KINDS[kind]
        d = ' stroke-dasharray="5 3"' if dashed else ""
        self.boxes.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}"{d}/>')
    def label(self, x, y, s, size=10, fill=MUTED, anchor="middle", weight=None, mono=False, halo=False):
        a = "" if size == 10 else f' font-size="{size}"'
        a += "" if fill == MUTED else f' fill="{fill}"'
        a += "" if anchor == "middle" else f' text-anchor="{anchor}"'
        a += f' font-weight="{weight}"' if weight else ""
        a += ' font-family="monospace"' if mono else ""
        # a white outline painted under the glyphs hides any line the label sits on
        a += ' stroke="#fff" stroke-width="4" stroke-linejoin="round" paint-order="stroke"' if halo else ""
        self.text.append(f'<text x="{x:g}" y="{y:g}"{a}>{esc(s)}</text>')
    def card(self, x, y, w, h, title, lines=(), kind="blue", title_size=13, line_size=9.5, mono_lines=False, dashed=False):
        """A box with a bold title and any number of centred detail lines."""
        self.box(x, y, w, h, kind, dashed=dashed)
        cx = x + w / 2
        n = len(lines)
        block = 16 + n * 12                      # title block + one line each
        top = y + (h - block) / 2 + 12
        self.label(cx, top, title, title_size, INK, weight="600")
        for i, ln in enumerate(lines):
            self.label(cx, top + 15 + i * 12, ln, line_size, mono=mono_lines)
    def render(self):
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" '
                f'width="{self.w}" height="{self.h}" font-family="{FONT}">'
                '<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
                f'orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="{MUTED}"/></marker></defs>'
                f'<rect width="{self.w}" height="{self.h}" fill="#ffffff"/>'
                f'<g fill="none" stroke="{MUTED}" stroke-width="1.5" marker-end="url(#a)">{"".join(self.arrows)}</g>'
                f'{"".join(self.boxes)}'
                f'<g font-size="10" fill="{MUTED}" text-anchor="middle">{"".join(self.text)}</g></svg>')

def emit(svg, name):
    """Write `name.svg` next to this file, whatever the working directory."""
    out = svg.render()
    xml.dom.minidom.parseString(out)             # fail loudly on malformed output
    pathlib.Path(__file__).with_name(f"{name}.svg").write_text(out)
    print(f"{name:22s} {len(out):>6} bytes  {svg.w}x{svg.h}")
