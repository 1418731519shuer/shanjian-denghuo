#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""剧本质量门禁（lint）—— 任何剧本入库/发布前必过。

用法：
  python tools/lint_script.py 剧本.json                # 检查单个剧本 JSON
  python tools/lint_script.py index.html               # 检查内嵌 EMBEDDED_SCRIPT
  python tools/lint_script.py games/                   # 检查目录下所有 script.json
  python tools/lint_script.py                          # 默认检查 index.html + games/ + scripts/

规则（错误级，CI 拦截）：
  R1 悬空引用（goto/选项/判定/require_else/锚点）
  R2 自引用回环（跳回自己所在场景）
  R3 结局不可达 / 没有任何结局
  R4 场景收尾卡死（无 end/goto/全跳转选项/双分支判定）
  R5 require 必须是字符串表达式
  R6 结局名规范（「结局·」前缀、无模板串字符）
  R7 站位表情合法 / 角色引用已定义 / say 说话人已定义
  R8 数值门槛不可达（条件所需 > 该场景前最大可得，粗略沿场景序累计）
告警级（只提示）：R9 空串 goto、未使用属性、say 未在站位表（引擎可自动补位）
"""
import json
import os
import re
import sys

EMO_DEFAULT = {'normal', 'smile', 'angry', 'sad', 'surprise', 'shy'}


class Lint:
    def __init__(self, script, name):
        self.sc = script
        self.name = name
        self.errors = []
        self.warnings = []
        self.ids = {s['id'] for s in script.get('scenes', [])}
        self.smap = {s['id']: s for s in script.get('scenes', [])}
        self.chars = script.get('characters', {})
        self.attrs = script.get('attrs', {}) or {}

    def err(self, where, msg):
        self.errors.append(f'[{self.name}] {where}: {msg}')

    def warn(self, where, msg):
        self.warnings.append(f'[{self.name}] {where}: {msg}')

    # ---- 工具 ----
    @staticmethod
    def split_ref(ref):
        scene, _, anchor = str(ref).partition(':')
        return scene, anchor

    def check_ref(self, ref, where, cur_sid):
        """R1+R2：悬空 + 自环。返回是否 OK。"""
        scene, anchor = self.split_ref(ref)
        if scene == '' or scene == cur_sid:
            self.err(where, f'自引用回环 "{ref}"（跳回自己所在场景，死循环）')
            return False
        if scene not in self.ids:
            self.err(where, f'悬空跳转 "{ref}"（场景不存在）')
            return False
        if anchor:
            ts = self.smap[scene]
            if not any(c.get('type') == 'mark' and c.get('id') == anchor
                       for c in ts.get('script', [])):
                self.err(where, f'锚点 "{anchor}" 在场景 "{scene}" 不存在')
                return False
        return True

    # ---- 各规则 ----
    def r12567_refs_and_types(self):
        for s in self.sc.get('scenes', []):
            sid = s['id']
            req = s.get('require')
            if req is not None and not isinstance(req, str):
                self.err(sid, f'require 必须是字符串表达式，实际是 {type(req).__name__}')
            if s.get('require_else'):
                self.check_ref(s['require_else'], sid + ' require_else', sid)
            for ch in s.get('chars') or []:
                if ch.get('id') not in self.chars:
                    self.err(sid, f'站位引用未定义角色 "{ch.get("id")}"')
                    continue
                sp = ch.get('sprite')
                if sp:
                    valid = set((self.chars[ch['id']].get('sprites') or {}).keys()) or EMO_DEFAULT
                    if sp not in valid:
                        self.err(sid, f'站位表情 "{sp}" 不在角色 {ch["id"]} 的立绘表（{sorted(valid)}）')
            for i, c in enumerate(s.get('script') or []):
                w = f'{sid} 第{i + 1}条'
                ty = c.get('type')
                if ty == 'say':
                    if c.get('who') not in self.chars:
                        self.err(w, f'say 引用未定义角色 "{c.get("who")}"')
                    else:
                        onstage = {x.get('id') for x in (s.get('chars') or [])}
                        if c['who'] not in onstage:
                            self.warn(w, f'say 说话人 "{c["who"]}" 不在站位表（运行时会自动补位）')
                if ty == 'goto':
                    if c.get('target') == '':
                        self.warn(w, 'goto 目标是空串（=无效指令）')
                    elif c.get('target'):
                        self.check_ref(c['target'], w + ' goto', sid)
                if ty == 'choice':
                    for o in c.get('options') or []:
                        g = o.get('goto')
                        if g:
                            self.check_ref(g, w + f' 选项「{(o.get("text") or "")[:12]}」', sid)
                if ty == 'check':
                    for k in ('success', 'fail'):
                        g = (c.get(k) or {}).get('goto')
                        if g:
                            self.check_ref(g, w + f' 判定{k}', sid)
                if ty == 'end':
                    label = c.get('label', '')
                    if re.search(r'[=?:{}\[\]"]', label):
                        self.err(w, f'结局名含模板串字符: "{label[:30]}"')
                    elif not label.startswith('结局'):
                        self.warn(w, f'结局名建议加「结局·」前缀: "{label}"')

    def _exits(self, s):
        outs = []
        for c in s.get('script') or []:
            ty = c.get('type')
            if ty == 'goto' and c.get('target'):
                outs.append(self.split_ref(c['target'])[0] or s['id'])
            elif ty == 'choice':
                for o in c.get('options') or []:
                    outs.append(self.split_ref(o['goto'])[0] if o.get('goto') else None)
            elif ty == 'check':
                for k in ('success', 'fail'):
                    g = (c.get(k) or {}).get('goto')
                    outs.append(self.split_ref(g)[0] if g else None)
            elif ty == 'end':
                outs.append('END')
        return outs

    def r34_reach_and_deadend(self):
        scenes = self.sc.get('scenes', [])
        if not scenes:
            self.err(self.name, '没有任何场景')
            return
        adj = {sid: set() for sid in self.ids}
        for i, s in enumerate(scenes):
            if s.get('require_else'):
                adj[s['id']].add(self.split_ref(s['require_else'])[0])
            elif s.get('require') and i + 1 < len(scenes):
                adj[s['id']].add(scenes[i + 1]['id'])
            for o in self._exits(s):
                if o and o != 'END':
                    adj[s['id']].add(o)
        seen = {scenes[0]['id']}
        q = list(seen)
        while q:
            cur = q.pop()
            for nx in adj.get(cur, ()):
                if nx in self.ids and nx not in seen:
                    seen.add(nx)
                    q.append(nx)
        ends = {s['id'] for s in scenes for c in s.get('script', []) if c.get('type') == 'end'}
        if not ends:
            self.err(self.name, '剧本没有任何 end 结局')
        for sid in sorted(ends - seen):
            self.err(sid, '结局场景从入口不可达（玩家打不到）')
        # R4 收尾卡死
        for s in scenes:
            cmds = s.get('script') or []
            if not cmds:
                self.err(s['id'], '场景内容为空')
                continue
            safe = False
            for c in reversed(cmds):
                ty = c.get('type')
                if ty == 'end':
                    safe = True
                elif ty == 'goto' and 'if' not in c and c.get('target'):
                    safe = True
                elif ty == 'choice':
                    if c.get('options') and all(o.get('goto') for o in c['options']):
                        safe = True
                elif ty == 'check':
                    if 'if' not in c and (c.get('success') or {}).get('goto') and (c.get('fail') or {}).get('goto'):
                        safe = True
            if not safe:
                self.err(s['id'], '场景可能执行到末尾卡死（无 end/无条件 goto/全跳转选项/双分支判定收尾）')

    def r8_economy(self):
        """沿场景顺序粗略累计各属性最大可得，校验 >=门槛 可达。"""
        init = {k: (a.get('init') or 0) for k, a in self.attrs.items()}
        cum = {}
        for s in self.sc.get('scenes', []):
            avail0 = {**init, **cum}
            checks = []
            if s.get('require'):
                checks.append(('require 门', s['require']))
            for c in s.get('script') or []:
                if c.get('if'):
                    checks.append(('指令条件', c['if']))
                if c.get('type') == 'choice':
                    for o in c.get('options') or []:
                        if o.get('if'):
                            checks.append((f"选项「{(o.get('text') or '')[:12]}」", o['if']))
                if c.get('type') == 'check' and c.get('mode') != 'roll':
                    checks.append(('判定', f"{c.get('attr')}>={c.get('value', 0)}"))
                # 累计
                for vs in ([c.get('vars')] if c.get('type') == 'set' else []):
                    self._accum(vs, cum)
                if c.get('type') == 'choice':
                    for o in c.get('options') or []:
                        self._accum(o.get('set'), cum)
                if c.get('type') == 'check':
                    for k in ('success', 'fail'):
                        self._accum((c.get(k) or {}).get('set'), cum)
            for what, expr in checks:
                for m in re.finditer(r'([A-Za-z_][A-Za-z0-9_]*)\s*>=\s*(\d+)', str(expr)):
                    attr, need = m.group(1), int(m.group(2))
                    avail = avail0.get(attr, 0) + cum.get(attr, 0) + init.get(attr, 0) - avail0.get(attr, 0)
                    avail = cum.get(attr, 0) + init.get(attr, 0)
                    if avail < need:
                        self.err(s['id'], f'{what}: {attr}>={need} 但此处最多只有 {avail}（永远达不成）')

    @staticmethod
    def _accum(vs, cum):
        for k, v in (vs or {}).items():
            m = re.match(r'^' + re.escape(k) + r'\+(\d+)$', str(v))
            if m:
                cum[k] = cum.get(k, 0) + int(m.group(1))

    def run(self):
        if not self.sc.get('scenes'):
            self.err(self.name, '缺少 scenes')
            return self.errors, self.warnings
        self.r12567_refs_and_types()
        self.r34_reach_and_deadend()
        self.r8_economy()
        return self.errors, self.warnings


def lint_one(path):
    if path.endswith('.html'):
        t = open(path, encoding='utf-8').read()
        m = re.search(r'const EMBEDDED_SCRIPT = (\{.*?\});\s*\n', t, re.S)
        if not m:
            return [f'[{path}] 找不到 EMBEDDED_SCRIPT'], []
        sc = json.loads(m.group(1))
    else:
        sc = json.load(open(path, encoding='utf-8'))
    return Lint(sc, os.path.basename(path)).run()


def main():
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding='utf-8')
        except Exception:
            pass
    targets = sys.argv[1:]
    if not targets:
        targets = ['index.html']
        if os.path.isdir('games'):
            for d in sorted(os.listdir('games')):
                p = os.path.join('games', d, 'script.json')
                if os.path.exists(p):
                    targets.append(p)
        if os.path.isdir('scripts'):
            for f in sorted(os.listdir('scripts')):
                if f.endswith('.json'):
                    targets.append(os.path.join('scripts', f))
    all_err, all_warn = [], []
    for t in targets:
        if os.path.isdir(t):
            for d in sorted(os.listdir(t)):
                p = os.path.join(t, d, 'script.json')
                if os.path.exists(p):
                    e, w = lint_one(p)
                    all_err += e
                    all_warn += w
            continue
        e, w = lint_one(t)
        all_err += e
        all_warn += w
        print(f'[检查] {t}: 错误 {len(e)}，告警 {len(w)}')
    for w in all_warn:
        print('  [告警]', w)
    for e in all_err:
        print('  [错误]', e)
    print(f'\n== 汇总：{len(all_err)} 错误，{len(all_warn)} 告警 ==')
    sys.exit(1 if all_err else 0)


if __name__ == '__main__':
    main()
