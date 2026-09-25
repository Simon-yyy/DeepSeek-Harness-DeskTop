"use strict";

function findFlowMappingEnd(text, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let inComment = false;

  for (let i = openIndex; i < text.length; i++) {
    const char = text[i];

    if (inComment) {
      if (char === "\n") inComment = false;
      continue;
    }

    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        quote = null;
      }
      continue;
    }

    if (quote === "'") {
      if (char === "'" && text[i + 1] === "'") {
        i++;
      } else if (char === "'") {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
      inComment = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }

  return -1;
}

function replaceYamlProvidersBlock(fullYamlText, newBlock) {
  const match = fullYamlText.match(/(?:^|\n)(providers:\s*\{)/);
  if (match) {
    const startIndex = match.index + (match[0].startsWith("\n") ? 1 : 0);
    const openIndex = fullYamlText.indexOf("{", startIndex);
    const endIndex = findFlowMappingEnd(fullYamlText, openIndex);
    if (endIndex === -1) {
      throw new Error("现有 providers 配置的大括号未闭合，已取消保存以保护原文件");
    }
    return fullYamlText.slice(0, startIndex) + newBlock + fullYamlText.slice(endIndex);
  }

  if (/(?:^|\n)providers:/.test(fullYamlText)) {
    return fullYamlText.replace(/(^|\n)providers:[\s\S]*?(?=\n[a-zA-Z0-9_-]+:|$)/, (_match, prefix) => prefix + newBlock);
  }

  return fullYamlText.trimEnd() + "\n\n" + newBlock + "\n";
}

module.exports = { replaceYamlProvidersBlock };
