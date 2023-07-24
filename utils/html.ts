import { readFileSync } from 'fs';
import { render } from 'ejs';

export function getTemplateHtml(
  template: string,
  variables: { [key: string]: any }
) {
  const rootPath = './templates';
  const templateHtml = readFileSync(`${rootPath}/${template}`, 'utf8');

  const html = render(templateHtml, variables, {
    views: [rootPath],
  });

  return html;
}
