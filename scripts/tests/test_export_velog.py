from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "export-velog.py"
SPEC = importlib.util.spec_from_file_location("export_velog", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {SCRIPT}")
export_velog = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = export_velog
SPEC.loader.exec_module(export_velog)


class RewriteAssetsTests(unittest.TestCase):
    article_url = "https://example.com/homelab-notes/notes/backup/"

    def test_rewrites_assets_in_markdown_reference_and_html_prose(self) -> None:
        source = """![diagram](diagram.png)
[report][report]
[report]: files/result.pdf "Result"
<video poster="media/poster.webp"></video>
"""

        actual = export_velog.rewrite_assets(source, self.article_url)

        self.assertIn(
            "![diagram](https://example.com/homelab-notes/notes/backup/diagram.png)",
            actual,
        )
        self.assertIn(
            '[report]: https://example.com/homelab-notes/notes/backup/files/result.pdf "Result"',
            actual,
        )
        self.assertIn(
            'poster="https://example.com/homelab-notes/notes/backup/media/poster.webp"',
            actual,
        )

    def test_preserves_fenced_inline_indented_and_html_code_examples(self) -> None:
        source = """Prose: ![real](real.png)

```markdown
![fenced](fenced.png)
<img src="fenced-html.png">
```

~~~~html
<video poster="tilde-fence.webp"></video>
~~~~

Inline `![inline](inline.png)` and ``<img src="double-tick.png">``.

    ![indented](indented.png)
    <img src="indented-html.png">

<code>![html-code](html-code.png)</code>
<pre><img src="html-pre.png"></pre>

After: <img src="after.svg">
"""

        actual = export_velog.rewrite_assets(source, self.article_url)

        self.assertIn(
            "Prose: ![real](https://example.com/homelab-notes/notes/backup/real.png)",
            actual,
        )
        self.assertIn('After: <img src="https://example.com/homelab-notes/notes/backup/after.svg">', actual)
        for unchanged in (
            "![fenced](fenced.png)",
            '<img src="fenced-html.png">',
            '<video poster="tilde-fence.webp"></video>',
            "`![inline](inline.png)`",
            '``<img src="double-tick.png">``',
            "![indented](indented.png)",
            '<img src="indented-html.png">',
            "<code>![html-code](html-code.png)</code>",
            '<pre><img src="html-pre.png"></pre>',
        ):
            self.assertIn(unchanged, actual)

    def test_code_only_relative_examples_do_not_require_article_url(self) -> None:
        source = """```markdown
![example](only-in-code.png)
```
Inline `<img src="also-code.png">`.
"""

        self.assertEqual(source, export_velog.rewrite_assets(source, None))

    def test_relative_prose_asset_without_article_url_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "pass --article-url"):
            export_velog.rewrite_assets("![real](real.png)\n", None)


if __name__ == "__main__":
    unittest.main()
