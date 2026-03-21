import { useState } from 'react';
import { X, Copy, Check } from 'lucide-react';

interface Props {
  url: string;
  body: unknown;
  apiType: 'completions' | 'responses';
  sdkType: 'openai' | 'langchain' | 'agentframework';
  apiVersion: string;
  onClose: () => void;
}

type Lang = 'javascript' | 'python' | 'curl';
const LANGS: { key: Lang; label: string }[] = [
  { key: 'javascript', label: 'JavaScript' },
  { key: 'python', label: 'Python' },
  { key: 'curl', label: 'cURL' },
];

export default function CodeModal({ url, body, apiType, sdkType, apiVersion, onClose }: Props) {
  const [lang, setLang] = useState<Lang>('javascript');
  const [copied, setCopied] = useState(false);

  const code = generateCode(lang, url, body, apiType, sdkType, apiVersion);

  const handleCopy = () => {
    void navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="code-modal-overlay" onClick={onClose}>
      <div className="code-modal-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="code-modal-header">
          <h2>Source Code</h2>
          <div className="code-modal-tabs">
            {LANGS.map((l) => (
              <button
                key={l.key}
                className={`code-modal-tab${lang === l.key ? ' active' : ''}`}
                onClick={() => setLang(l.key)}
              >
                {l.label}
              </button>
            ))}
          </div>
          <div className="code-modal-actions">
            <button className="icon-btn" onClick={handleCopy} title="Copy code">
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
            <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
          </div>
        </div>
        <div className="code-modal-body">
          <pre className="code-modal-pre"><code>{code}</code></pre>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Code generators                                                    */
/* ------------------------------------------------------------------ */

function generateCode(
  lang: Lang,
  url: string,
  body: unknown,
  apiType: 'completions' | 'responses',
  sdkType: 'openai' | 'langchain' | 'agentframework',
  apiVersion: string,
): string {
  const bodyObj = body as Record<string, unknown>;
  const model = (bodyObj.model as string) ?? 'gpt-4.1-mini';
  const messages = bodyObj.messages as { role: string; content: string }[] | undefined;
  const input = bodyObj.input as { role: string; content: string }[] | undefined;
  const instructions = (bodyObj.instructions as string) ?? '';
  const stream = bodyObj.stream === true;

  if (lang === 'curl') {
    return generateCurl(url, body);
  }

  if (sdkType === 'openai') {
    return lang === 'python'
      ? generateOpenAIPython(url, model, apiType, apiVersion, messages, input, instructions, stream)
      : generateOpenAIJS(url, model, apiType, apiVersion, messages, input, instructions, stream);
  }

  if (sdkType === 'langchain') {
    return lang === 'python'
      ? generateLangChainPython(url, model, apiVersion)
      : generateLangChainJS(url, model, apiVersion);
  }

  // Agent Framework
  return lang === 'python'
    ? generateAgentFrameworkPython(url, model, apiVersion, instructions)
    : generateAgentFrameworkJS(url, model, apiVersion, instructions);
}

/** Extract just the gateway base URL (scheme + host), stripping any API path segments. */
function gatewayBase(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url.replace(/\/chat\/completions.*|\/responses.*/, '').replace(/\/[^/]+$/, '');
  }
}

function generateCurl(url: string, body: unknown): string {
  const json = JSON.stringify(body, null, 2);
  return `curl "${url}" \\
  -H "Content-Type: application/json" \\
  -H "Ocp-Apim-Subscription-Key: $APIM_SUBSCRIPTION_KEY" \\
  -d '${json}'`;
}

function generateOpenAIPython(
  url: string, model: string, apiType: string, apiVersion: string,
  messages?: { role: string; content: string }[],
  input?: { role: string; content: string }[],
  instructions?: string, stream?: boolean,
): string {
  const base = gatewayBase(url);
  if (apiType === 'completions') {
    const msgs = messages ? JSON.stringify(messages, null, 4).replace(/\n/g, '\n    ') : '[]';
    return `from openai import AzureOpenAI

client = AzureOpenAI(
    azure_endpoint="${base}",
    api_key="<your-subscription-key>",
    api_version="${apiVersion}",
)

response = client.chat.completions.create(
    model="${model}",
    messages=${msgs},${stream ? '\n    stream=True,' : ''}
)
${stream ? `\nfor chunk in response:\n    if chunk.choices and chunk.choices[0].delta.content:\n        print(chunk.choices[0].delta.content, end="")` : '\nprint(response.choices[0].message.content)'}`;
  }

  // Responses API
  const inp = input ? JSON.stringify(input, null, 4).replace(/\n/g, '\n    ') : '[]';
  return `from openai import AzureOpenAI

client = AzureOpenAI(
    azure_endpoint="${base}",
    api_key="<your-subscription-key>",
    api_version="${apiVersion}",
)

response = client.responses.create(
    model="${model}",${instructions ? `\n    instructions="${instructions}",` : ''}
    input=${inp},${stream ? '\n    stream=True,' : ''}
)
${stream ? `\nfor event in response:\n    if event.type == "response.output_text.delta":\n        print(event.delta, end="")` : '\nprint(response.output_text)'}`;
}

function generateOpenAIJS(
  url: string, model: string, apiType: string, apiVersion: string,
  messages?: { role: string; content: string }[],
  input?: { role: string; content: string }[],
  instructions?: string, stream?: boolean,
): string {
  const base = gatewayBase(url);
  if (apiType === 'completions') {
    const msgs = JSON.stringify(messages ?? [], null, 2).replace(/\n/g, '\n  ');
    return `import { AzureOpenAI } from "openai";

const client = new AzureOpenAI({
  endpoint: "${base}",
  apiKey: "<your-subscription-key>",
  apiVersion: "${apiVersion}",
});

const response = await client.chat.completions.create({
  model: "${model}",
  messages: ${msgs},${stream ? '\n  stream: true,' : ''}
});
${stream ? `\nfor await (const chunk of response) {\n  const content = chunk.choices?.[0]?.delta?.content;\n  if (content) process.stdout.write(content);\n}` : '\nconsole.log(response.choices[0].message.content);'}`;
  }

  // Responses API
  const inp = JSON.stringify(input ?? [], null, 2).replace(/\n/g, '\n  ');
  return `import { AzureOpenAI } from "openai";

const client = new AzureOpenAI({
  endpoint: "${base}",
  apiKey: "<your-subscription-key>",
  apiVersion: "${apiVersion}",
});

const response = await client.responses.create({
  model: "${model}",${instructions ? `\n  instructions: "${instructions}",` : ''}
  input: ${inp},${stream ? '\n  stream: true,' : ''}
});
${stream ? `\nfor await (const event of response) {\n  if (event.type === "response.output_text.delta") {\n    process.stdout.write(event.delta);\n  }\n}` : '\nconsole.log(response.output_text);'}`;
}

function generateLangChainPython(url: string, model: string, apiVersion: string): string {
  const base = gatewayBase(url);
  return `from langchain_openai import AzureChatOpenAI

llm = AzureChatOpenAI(
    azure_endpoint="${base}",
    api_key="<your-subscription-key>",
    api_version="${apiVersion}",
    model="${model}",
)

response = llm.invoke("Hello, how can you help me?")
print(response.content)`;
}

function generateLangChainJS(url: string, model: string, apiVersion: string): string {
  const base = gatewayBase(url);
  return `import { AzureChatOpenAI } from "@langchain/openai";

const llm = new AzureChatOpenAI({
  azureOpenAIApiEndpoint: "${base}",
  azureOpenAIApiKey: "<your-subscription-key>",
  azureOpenAIApiVersion: "${apiVersion}",
  model: "${model}",
});

const response = await llm.invoke("Hello, how can you help me?");
console.log(response.content);`;
}

function generateAgentFrameworkPython(url: string, model: string, apiVersion: string, instructions?: string): string {
  const base = gatewayBase(url);
  return `from azure.identity import DefaultAzureCredential
from semantic_kernel import Kernel
from semantic_kernel.connectors.ai.open_ai import AzureChatCompletion

kernel = Kernel()
kernel.add_service(AzureChatCompletion(
    endpoint="${base}",
    api_key="<your-subscription-key>",
    api_version="${apiVersion}",
    deployment_name="${model}",
))

result = await kernel.invoke_prompt(
    "${instructions || 'Hello, how can you help me?'}"
)
print(result)`;
}

function generateAgentFrameworkJS(url: string, model: string, apiVersion: string, instructions?: string): string {
  const base = gatewayBase(url);
  return `import { OpenAIPromptExecutionSettings } from "@microsoft/semantic-kernel";

const settings = new OpenAIPromptExecutionSettings({
  endpoint: "${base}",
  apiKey: "<your-subscription-key>",
  apiVersion: "${apiVersion}",
  deploymentName: "${model}",
});

// Use with Semantic Kernel agent
const prompt = "${instructions || 'Hello, how can you help me?'}";
// Add to your kernel and invoke`;
}
