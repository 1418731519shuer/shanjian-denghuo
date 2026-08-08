# -*- coding: utf-8 -*-
import re, os, sys
html = open('index.html', encoding='utf-8').read()
refs = set(re.findall(r"((?:bg|cg|chars)/[^'\"()\\]+?\.webp)", html))
# 只校验合法文件名字符（过滤帮助文案里的 <slug> 等占位示例与 xxx 占位符）
refs = {r for r in refs if re.fullmatch(r'[a-z0-9_/.\-]+', r) and 'xxx' not in r}
missing = [r for r in sorted(refs) if not os.path.exists(os.path.join('assets', r))]
print('refs:', len(refs), 'missing:', len(missing))
for m in missing:
    print('  MISSING', m)
sys.exit(1 if missing else 0)
