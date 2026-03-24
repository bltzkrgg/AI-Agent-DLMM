import { createMessage } from './provider.js';

export async function runAgent({ system, tools, messages, executeTool }) {
  const history = [...messages];

  for (let i = 0; i < 5; i++) {
    const res = await createMessage({
      system,
      tools,
      messages: history,
    });

    const content = res.content || [];
    const toolUse = content.find(c => c.type === 'tool_use');

    if (!toolUse) {
      return content.map(c => c.text || '').join('');
    }

    const result = await executeTool(toolUse.name, toolUse.input || {});

    history.push({ role: 'assistant', content });
    history.push({ role: 'tool', content: result });
  }

  return 'Max iterations reached';
}
