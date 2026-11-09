# userscripts

Personal Tampermonkey userscripts. Each script installs from its raw GitHub URL and
updates itself through `@updateURL` / `@downloadURL`, so every device picks up new
versions automatically.

| Script | Folder | Install |
|---|---|---|
| Bilibili 扩展倍速（最高 10x） | [bilibili-extended-speed](bilibili-extended-speed/) | [install](https://raw.githubusercontent.com/__GH_USER__/__GH_REPO__/main/bilibili-extended-speed/bilibili-extended-speed.user.js) |
| B站精准搜索 · 自动补页 | [bilibili-search-enhancer](bilibili-search-enhancer/) | [install](https://raw.githubusercontent.com/__GH_USER__/__GH_REPO__/main/bilibili-search-enhancer/bilibili-search-enhancer.user.js) |
| B站字幕和评论提取 | [bilibili-subtitle](bilibili-subtitle/) | [install](https://raw.githubusercontent.com/__GH_USER__/__GH_REPO__/main/bilibili-subtitle/bilibili-subtitle.user.js) |
| YouTube 方向键增强 | [youtube-arrow-enhancer](youtube-arrow-enhancer/) | [install](https://raw.githubusercontent.com/__GH_USER__/__GH_REPO__/main/youtube-arrow-enhancer/youtube-arrow-enhancer.user.js) |
| FC2PPVDB Enhanced（本地修复版） | [fc2ppvdb-enhanced](fc2ppvdb-enhanced/) | [install](https://raw.githubusercontent.com/__GH_USER__/__GH_REPO__/main/fc2ppvdb-enhanced/fc2ppvdb-enhanced.user.js) |

## Workflow

1. Edit a `*.user.js` file.
2. `git commit` — the pre-commit hook bumps the last part of `@version`
   (e.g. `1.1.0` → `1.1.1`) unless you already changed it yourself.
3. `git push`. Tampermonkey on each device sees the new `@version` at its next
   update check (Dashboard → Settings → Script Update sets the interval; the
   dashboard's "Check for updates" forces it).

Enable the hook once in every clone you edit from:

```bash
git config core.hooksPath .githooks
```

Keep `@name` and `@namespace` unchanged: Tampermonkey identifies a script by them,
and changing either installs it as a separate script.

## Notes

- `fc2ppvdb-enhanced` is a modified copy of *FC2PPVDB Enhanced Edition* by Icarusle
  (MIT, see its [LICENSE](fc2ppvdb-enhanced/LICENSE)). It updates from this repo, not
  from Sleazy Fork, so local fixes are not overwritten by upstream releases.
- Tests for the bilibili scripts and fc2ppvdb-enhanced need Node.js (some need Playwright).
