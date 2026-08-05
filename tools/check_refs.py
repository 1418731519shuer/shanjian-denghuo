# -*- coding: utf-8 -*-
import re, os, sys
html = open('index.html', encoding='utf-8').read()
refs = set(re.findall(r"((?:bg|cg|chars)/[^'\"()\\]+?\.webp)", html))
refs = {r for r in refs if 'xxx' not in r}  # 编辑器占位符
missing = [r for r in sorted(refs) if not os.path.exists(os.path.join('assets', r))]
print('refs:', len(refs), 'missing:', len(missing))
for m in missing:
    print('  MISSING', m)
sys.exit(1 if missing else 0)
