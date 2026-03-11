import { marked } from 'marked';
import hljs from 'highlight.js';

export function escapeHtml(str: string): string {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function getFileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const icons: Record<string, string> = {
    ts: '⊤', tsx: '⊤', js: '◇', jsx: '◇', py: '⊕', rs: '⊗', go: '◈',
    json: '{}', yaml: '≡', yml: '≡', toml: '≡', md: '◉', txt: '◉',
    html: '◇', css: '◇', scss: '◇', astro: '✦', vue: '▽', svelte: '◈', cshtml: '◇', razor: '◇', cs: '⊤',
    svg: '▣', png: '▣', jpg: '▣', gif: '▣', webp: '▣',
    lock: '⊟', gitignore: '⊘',
  };
  return icons[ext] || '◇';
}

const monacoLangMap: Record<string, string> = {
  // TypeScript
  ts: 'typescript', tsx: 'typescript', cts: 'typescript', mts: 'typescript',
  // JavaScript
  js: 'javascript', es6: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  // Web
  html: 'html', htm: 'html', shtml: 'html', xhtml: 'html', jsp: 'html', asp: 'html', aspx: 'html', jshtm: 'html', mdoc: 'html', astro: 'html',
  css: 'css', less: 'less', scss: 'scss',
  xml: 'xml', xsd: 'xml', dtd: 'xml', ascx: 'xml', csproj: 'xml', config: 'xml', props: 'xml', targets: 'xml',
  wxi: 'xml', wxl: 'xml', wxs: 'xml', xaml: 'xml', xslt: 'xml', xsl: 'xml', opf: 'xml',
  // Templating
  pug: 'pug', jade: 'pug', handlebars: 'handlebars', hbs: 'handlebars', twig: 'twig',
  liquid: 'liquid', ftl: 'freemarker2', ftlh: 'freemarker2', ftlx: 'freemarker2',
  // Data
  json: 'json', yaml: 'yaml', yml: 'yaml', ini: 'ini', properties: 'ini', gitconfig: 'ini', toml: 'ini',
  // Markdown
  md: 'markdown', markdown: 'markdown', mdown: 'markdown', mkdn: 'markdown', mkd: 'markdown',
  mdwn: 'markdown', mdtxt: 'markdown', mdtext: 'markdown', mdx: 'mdx',
  // .NET
  cs: 'csharp', csx: 'csharp', cake: 'csharp', cshtml: 'razor',
  fs: 'fsharp', fsi: 'fsharp', fsx: 'fsharp', fsscript: 'fsharp',
  vb: 'vb',
  // JVM
  java: 'java', jav: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', sc: 'scala', sbt: 'scala',
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure', edn: 'clojure',
  // Systems
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  rs: 'rust', rlib: 'rust',
  go: 'go',
  swift: 'swift',
  m: 'objective-c',
  // Scripting
  py: 'python', rpy: 'python', pyw: 'python', cpy: 'python', gyp: 'python', gypi: 'python',
  rb: 'ruby', rbx: 'ruby', rjs: 'ruby', gemspec: 'ruby',
  php: 'php', php4: 'php', php5: 'php', phtml: 'php', ctp: 'php',
  pl: 'perl', pm: 'perl',
  lua: 'lua',
  r: 'r', rmd: 'r',
  jl: 'julia',
  tcl: 'tcl',
  coffee: 'coffeescript',
  ex: 'elixir', exs: 'elixir',
  dart: 'dart',
  // Shell / CLI
  sh: 'shell', bash: 'shell',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  bat: 'bat', cmd: 'bat',
  dockerfile: 'dockerfile',
  // Infrastructure / Config
  tf: 'hcl', tfvars: 'hcl', hcl: 'hcl',
  proto: 'protobuf',
  graphql: 'graphql', gql: 'graphql',
  bicep: 'bicep',
  // Database
  sql: 'sql',
  // HDL
  sv: 'systemverilog', svh: 'systemverilog', v: 'systemverilog', vh: 'systemverilog',
  // Other
  sol: 'solidity',
  rst: 'restructuredtext',
  scm: 'scheme', ss: 'scheme', sch: 'scheme', rkt: 'scheme',
  pas: 'pascal', p: 'pascal',
  wgsl: 'wgsl',
  abap: 'abap',
  cls: 'apex',
  s: 'mips',
  tsp: 'typespec',
};

export function getMonacoLang(path: string): string {
  const filename = path.split('/').pop() || '';
  if (/^Dockerfile/i.test(filename)) return 'dockerfile';
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return monacoLangMap[ext] || 'plaintext';
}

export function isRenderable(path: string): boolean {
  return /\.(md|html|astro|png|jpg|jpeg|gif|svg|webp|bmp|ico|avif)$/i.test(path);
}

export function isImageFile(path: string): boolean {
  return /\.(png|jpg|jpeg|gif|svg|webp|bmp|ico|avif|tiff|tif)$/i.test(path);
}

export function isBinaryExtension(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const binaryExts = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'tiff', 'tif', 'psd', 'avif',
    'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma',
    'mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm',
    'zip', 'tar', 'gz', 'bz2', '7z', 'rar', 'xz', 'zst',
    'exe', 'dll', 'so', 'dylib', 'bin', 'msi', 'deb', 'rpm', 'appimage',
    'woff', 'woff2', 'ttf', 'otf', 'eot',
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'class', 'pyc', 'pyo', 'o', 'obj', 'wasm', 'a', 'lib',
    'sqlite', 'db', 'sqlite3',
  ]);
  return binaryExts.has(ext);
}

export function classifyFile(file: File): string {
  const ext = (file.name || '').split('.').pop()?.toLowerCase() || '';
  const mime = (file.type || '').toLowerCase();
  if (/^image\/(jpeg|jpg|png|gif|webp)$/.test(mime) || /^(jpg|jpeg|png|gif|webp)$/.test(ext)) return 'image';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (/^(docx|xlsx|xls|pptx)$/.test(ext)) return 'office';
  const textMimes = /^(text\/|application\/json|application\/xml|application\/javascript|application\/typescript|application\/x-yaml|application\/toml)/;
  if (textMimes.test(mime)) return 'text';
  const textExts = /^(txt|md|csv|json|yaml|yml|toml|xml|html|htm|css|js|jsx|ts|tsx|mjs|cjs|py|rb|rs|go|java|c|cpp|cc|cxx|h|hpp|cs|swift|kt|kts|scala|sh|bash|zsh|fish|ps1|bat|cmd|sql|graphql|gql|lua|r|m|mm|pl|pm|php|ex|exs|erl|hs|elm|clj|cljs|dart|vue|svelte|astro|tf|hcl|dockerfile|makefile|cmake|gradle|groovy|ini|cfg|conf|env|log|diff|patch|rst|tex|bib|proto|thrift|avsc|lock|gitignore|editorconfig|prettierrc|eslintrc|babelrc|tsconfig)$/;
  if (textExts.test(ext)) return 'text';
  if (!ext && mime.startsWith('text/')) return 'text';
  return 'unsupported';
}

export function getAttachIcon(kind: string): string {
  switch (kind) {
    case 'image': return '🖼️';
    case 'pdf': return '📄';
    case 'text': return '📝';
    case 'office': return '📊';
    default: return '📎';
  }
}

export const svgCopy = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
export const svgCheck = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

// Markdown rendering setup
const mdRenderer = new marked.Renderer();
mdRenderer.html = function({ text }: { text: string }) { return escapeHtml(text); };
mdRenderer.code = function({ text, lang }: { text: string; lang?: string }) {
  let highlighted: string;
  if (lang && hljs.getLanguage(lang)) {
    highlighted = hljs.highlight(text, { language: lang }).value;
  } else {
    highlighted = escapeHtml(text);
  }
  const langLabel = lang ? `<span class="code-lang-label">${escapeHtml(lang)}</span>` : '';
  const copyBtn = `<span class="code-copy-btn" title="Copy code">${svgCopy}</span>`;
  return `<pre><div class="code-toolbar">${copyBtn}${langLabel}</div><code class="hljs${lang ? ' language-' + escapeHtml(lang) : ''}">${highlighted}</code></pre>`;
};
marked.setOptions({ breaks: true, gfm: true, renderer: mdRenderer });

export function renderMd(text: string): string {
  return marked.parse(text) as string;
}

export function debounce<T extends (...args: any[]) => void>(fn: T, delay: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: any[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  }) as T;
}

export function normalizePreviewUrl(url: string): string {
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  return url;
}

// Cached server IP for nip.io URLs (fetched once, lazy)
let _serverIp: string | null = null;
let _serverIpPromise: Promise<string> | null = null;

export function getServerIp(): string {
  // If location.hostname is already an IP, use it directly
  if (/^\d+\.\d+\.\d+\.\d+$/.test(location.hostname)) {
    _serverIp = location.hostname;
  }
  // Kick off async fetch if not resolved yet
  if (!_serverIp && !_serverIpPromise) {
    _serverIpPromise = fetch('/api/server-ip')
      .then(r => r.json())
      .then(d => { _serverIp = d.ip; return d.ip; })
      .catch(() => { _serverIp = '127.0.0.1'; return '127.0.0.1'; });
  }
  return _serverIp || location.hostname;
}

export function buildPortProxyUrl(port: number | string): string {
  const ip = getServerIp();
  return `${location.protocol}//${port}.port.on.${ip}.nip.io:${location.port}/`;
}

export function resolvePreviewSrc(url: string, mode: string): string {
  if (!url) return 'about:blank';
  url = normalizePreviewUrl(url);
  if (mode === 'server') {
    try {
      const u = new URL(url);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
        const port = u.port || (u.protocol === 'https:' ? '443' : '80');
        const ip = getServerIp();
        return location.protocol + '//' + port + '.port.on.' + ip + '.nip.io:' + location.port + (u.pathname || '/') + u.search + u.hash;
      }
    } catch {}
  }
  return url;
}

export function buildPreviewWsUrl(
  projectId: string,
  tabId: string,
  params: {
    targetPort: number;
    host?: string;
    protocol?: string;
    quality?: number;
    width?: number;
    height?: number;
    dpr?: number;
    isMobile?: boolean;
    hasTouch?: boolean;
  },
): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const qs = new URLSearchParams();
  qs.set('target_port', String(params.targetPort));
  if (params.host) qs.set('host', params.host);
  if (params.protocol) qs.set('protocol', params.protocol);
  if (params.quality) qs.set('quality', String(params.quality));
  if (params.width) qs.set('width', String(params.width));
  if (params.height) qs.set('height', String(params.height));
  if (params.dpr) qs.set('dpr', String(params.dpr));
  if (params.isMobile !== undefined) qs.set('isMobile', String(params.isMobile));
  if (params.hasTouch !== undefined) qs.set('hasTouch', String(params.hasTouch));
  return `${proto}//${location.host}/ws/preview/${encodeURIComponent(projectId)}/${encodeURIComponent(tabId)}?${qs.toString()}`;
}

export function filterMessages(messages: any[], showVerbose: boolean) {
  if (showVerbose) return messages.map((m, i) => ({ ...m, _idx: i, _collapsed: false }));
  const result: any[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === 'user') { result.push({ ...m, _idx: i, _collapsed: false }); i++; continue; }
    const blockStart = i;
    let lastAssistantIdx = -1, toolCount = 0, intermediateCount = 0;
    while (i < messages.length && messages[i].role !== 'user') {
      if (messages[i].role === 'tool') toolCount++;
      if (messages[i].role === 'assistant' || messages[i].role === 'thinking') lastAssistantIdx = i;
      i++;
    }
    for (let j = blockStart; j < i; j++) { if (j !== lastAssistantIdx) intermediateCount++; }
    if (intermediateCount > 0) {
      result.push({ role: '_collapsed', toolCount, intermediateCount, _idx: blockStart, _collapsed: true });
    }
    if (lastAssistantIdx >= 0) {
      result.push({ ...messages[lastAssistantIdx], _idx: lastAssistantIdx, _collapsed: false });
    }
  }
  return result;
}
