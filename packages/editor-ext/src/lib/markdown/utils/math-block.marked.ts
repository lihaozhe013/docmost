interface MathBlockToken {
  type: 'mathBlock';
  text: string;
  raw: string;
}

export const mathBlockExtension = {
  name: 'mathBlock',
  level: 'block',
  start(src: string) {
    return src.match(/\$\$/)?.index ?? -1;
  },
  tokenizer(src: string): MathBlockToken | undefined {
    const rule = /^\$\$(?!(\$))([\s\S]+?)\$\$/;
    const match = rule.exec(src);

    if (match) {
      return {
        type: 'mathBlock',
        raw: match[0],
        text: match[2]?.trim(),
      };
    }
  },
  renderer(token: MathBlockToken) {
    return `<div data-type="${token.type}" data-katex="true">${escapeHtml(token.text)}</div>`;
  },
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
