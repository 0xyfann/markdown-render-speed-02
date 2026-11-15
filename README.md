[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/0xyfann/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/0xyfann/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# markdown-render-speed-02

A fast, dependency-free Markdown-to-HTML parser in a single ES module
(`parse.js`), plus a small driver (`main.ts`) that renders a JSON array
of cases (`/input/cases.json`) to `/output/html.json`.

`parse(markdown)` is output-compatible with **marked 18.1.3**
(`marked.parse` with default options: `gfm: true`, `breaks: false`,
`pedantic: false`) — byte-for-byte identical HTML, including marked's
GFM extensions (tables, strikethrough, task lists, extended autolinks)
and its edge-case behaviors.

The parser is an original implementation written for this competition:
a container-stack block parser (block quotes, lists, fenced/indented
code, HTML blocks, tables) feeding a delimiter-stack inline parser
(emphasis, links, code spans, autolinks, entities). It uses only Node
builtins, no caching across calls, and is deterministic.

## Usage

```
node main.ts   # reads /input/cases.json, writes /output/html.json
```

## License

MIT — see `LICENSE`.

SPDX-License-Identifier: MIT
