const test = require("node:test");
const assert = require("node:assert/strict");
const { replaceYamlProvidersBlock } = require("../src/preload/utils/yaml-providers");

// R-02 验证服务商初始化的数据分支；R-05 直接调用生产 YAML 替换函数。
const DEFAULT_PROVIDERS = [
  {
    id: "agent-router",
    name: "agent router",
    protocol: "openai",
    apiKeyEnv: "AGENT_ROUTER_API_KEY",
    baseURL: "https://ps.air-outer.com/v1",
    models: ["glm-5.3"],
    timeout: "300",
    modelConfigs: {}
  },
  {
    id: "bigmodel",
    name: "GLM (智谱清言)",
    protocol: "openai",
    apiKeyEnv: "BIGMODEL_API_KEY",
    baseURL: "https://open.bigmodel.cn/api/coding/paas/v4",
    models: [
      "glm-4.5", "glm-4.5-air", "glm-4.6", "glm-4.7", "glm-5",
      "glm-5-turbo", "glm-5.1", "glm-5.2", "glm-5.3", "glm-5.3-flash"
    ],
    timeout: "180",
    modelConfigs: {}
  },
  {
    id: "deepseek",
    name: "DeepSeek 官方",
    protocol: "openai",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseURL: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    timeout: "300",
    modelConfigs: {}
  },
  {
    id: "openai",
    name: "OpenAI 官方",
    protocol: "openai",
    apiKeyEnv: "OPENAI_API_KEY",
    baseURL: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini", "o1", "o3-mini"],
    timeout: "120",
    modelConfigs: {}
  },
  {
    id: "anthropic",
    name: "Anthropic 官方",
    protocol: "anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    baseURL: "https://api.anthropic.com/v1",
    models: ["claude-3-7-sonnet-20250219", "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"],
    timeout: "180",
    modelConfigs: {}
  }
];

function resolveProvidersData(savedProvidersSnapshot) {
  let providersData;
  if (savedProvidersSnapshot && Array.isArray(savedProvidersSnapshot.providers) && savedProvidersSnapshot.providers.length > 0) {
    providersData = savedProvidersSnapshot.providers;
    for (const defP of DEFAULT_PROVIDERS) {
      const existing = providersData.find(p => p.id === defP.id);
      if (existing) {
        if (!existing.apiKeyEnv) existing.apiKeyEnv = defP.apiKeyEnv;
        if (!existing.protocol) existing.protocol = defP.protocol;
        if (!existing.modelConfigs) existing.modelConfigs = {};
        if (!Array.isArray(existing.models) || existing.models.length === 0) existing.models = [...defP.models];
      }
    }
  } else {
    providersData = JSON.parse(JSON.stringify(DEFAULT_PROVIDERS));
  }
  return providersData;
}

const safeYamlScalar = (val) => JSON.stringify(String(val ?? ""));
const safeYamlKey = (key) => /^[a-zA-Z0-9_-]+$/.test(String(key || "")) ? String(key) : JSON.stringify(String(key || ""));

function buildProvidersBlock(provList) {
  let providersYaml = "providers: {\n";
  for (const p of provList) {
    const mList = (p.models || []).map(m => "              { id: " + safeYamlScalar(m) + " }").join(",\n");
    const apiType = p.protocol === "anthropic" ? "anthropic-messages" : "openai-completions";
    const pKey = safeYamlKey(p.id);
    providersYaml += "      " + pKey + ":\n        {\n          displayName: " + safeYamlScalar(p.name || p.id) + ",\n          apiKeyEnv: " + (p.apiKeyEnv ? safeYamlScalar(p.apiKeyEnv) : '""') + ",\n          api: " + apiType + ",\n          baseURL: " + safeYamlScalar(p.baseURL || "") + ",\n          models:\n            [\n" + mList + "\n            ]\n        },\n";
  }
  providersYaml += "    }";
  return providersYaml;
}

test("CODE_REVIEW R-02 场景一：首次运行（无快照）正常初始化默认五大服务商，绝不抛出异常", () => {
  // 模拟首次运行：无任何快照
  const providersNull = resolveProvidersData(null);
  assert.ok(Array.isArray(providersNull), "结果必须为数组");
  assert.strictEqual(providersNull.length, 5);
  assert.strictEqual(providersNull[0].id, "agent-router");
  assert.strictEqual(providersNull[2].id, "deepseek");

  // 空快照对象容错
  const providersEmpty = resolveProvidersData({ providers: [] });
  assert.strictEqual(providersEmpty.length, 5);
});

test("CODE_REVIEW R-02 场景二：已有快照时无损恢复自定义服务商与模型列表，杜绝被覆盖重置", () => {
  const customSnapshot = {
    providers: [
      {
        id: "my-custom-vllm",
        name: 'My "Special" vLLM Endpoint',
        protocol: "openai",
        apiKeyEnv: "CUSTOM_VLLM_KEY",
        baseURL: "http://192.168.1.100:8000/v1",
        models: ["qwen-2.5-72b-instruct", "deepseek-r1-distill"],
        modelConfigs: {}
      },
      {
        id: "deepseek",
        name: "DeepSeek 官方 (自定义配置)",
        models: ["deepseek-chat"],
        // 故意缺少 protocol 与 apiKeyEnv，测试补齐能力
      }
    ]
  };

  const restored = resolveProvidersData(customSnapshot);
  assert.strictEqual(restored.length, 2, "快照中的自定义服务商数量必须精准保留");

  const customP = restored.find(p => p.id === "my-custom-vllm");
  assert.ok(customP, "自定义服务商必须存在");
  assert.strictEqual(customP.name, 'My "Special" vLLM Endpoint');
  assert.deepStrictEqual(customP.models, ["qwen-2.5-72b-instruct", "deepseek-r1-distill"], "自定义模型列表严禁被覆盖丢失");

  const deepseekP = restored.find(p => p.id === "deepseek");
  assert.ok(deepseekP);
  assert.strictEqual(deepseekP.apiKeyEnv, "DEEPSEEK_API_KEY", "缺失的默认预设属性应被自动补齐");
  assert.strictEqual(deepseekP.protocol, "openai");
  assert.deepStrictEqual(deepseekP.models, ["deepseek-chat"], "用户在快照中自定义的模型数量不被默认值重置");
});

test("CODE_REVIEW R-05 场景三：包含特殊字符、冒号、引号的服务商与模型能安全生成合法的 YAML", () => {
  const mockProviders = [
    {
      id: "provider:weird-id",
      name: 'Custom "Enterprise" AI: Internal',
      protocol: "openai",
      apiKeyEnv: "CORP_AI_KEY",
      baseURL: "https://api.corp.internal:8443/v1",
      models: ["model:version:1.0", 'special "quote" model']
    }
  ];

  const yamlBlock = buildProvidersBlock(mockProviders);
  assert.ok(yamlBlock.includes('"provider:weird-id":'), "非法标识符键名必须被安全转义包裹");
  assert.ok(yamlBlock.includes('displayName: "Custom \\"Enterprise\\" AI: Internal"'), "双引号与冒号必须被安全转义");
  assert.ok(yamlBlock.includes('apiKeyEnv: "CORP_AI_KEY"'), "apiKeyEnv 必须被安全转义");
  assert.ok(yamlBlock.includes('id: "model:version:1.0"'), "带冒号的模型名称必须被转义包裹");
  assert.ok(yamlBlock.includes('id: "special \\"quote\\" model"'));
});

test("CODE_REVIEW 深度加固：replaceYamlProvidersBlock 杜绝多服务商提前截断与旧服务商残留", () => {
  const multiProviderOldYaml = `# DSH Settings
agent-default-model:
  provider: bigmodel
  model: glm-5

providers: {
      bigmodel:
        {
          displayName: "GLM",
          baseURL: "https://open.bigmodel.cn/api/paas/v4",
          models: [
            { id: "glm-5" }
          ]
        },
      deepseek:
        {
          displayName: "DeepSeek",
          baseURL: "https://api.deepseek.com/v1",
          models: [
            { id: "deepseek-chat" }
          ]
        }
    }

ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
`;

  // 模拟将配置更新为仅包含新服务商 agent-router
  const newSingleProviderBlock = `providers: {
      agent-router:
        {
          displayName: "Agent Router Only",
          models: [
            { id: "glm-5.3" }
          ]
        }
    }`;

  const updatedYaml = replaceYamlProvidersBlock(multiProviderOldYaml, newSingleProviderBlock);

  // 核心断言 1：旧的第二个服务商 deepseek 必须被彻底移除，绝不发生部分截断残留
  assert.strictEqual(updatedYaml.includes("deepseek:"), false, "第二个服务商 deepseek 必须被完整替换，绝不残留");
  assert.strictEqual(updatedYaml.includes("agent-router:"), true, "新服务商必须完整写入");

  // 核心断言 2：providers 块之后的后续顶层配置 ui-onboarding 完好无损保留
  assert.strictEqual(updatedYaml.includes("ui-onboarding:"), true, "后续配置段必须完好保留");
  assert.strictEqual(updatedYaml.includes("welcomeNoticeVersion: 2026-08-13.1"), true);
});

test("CODE_REVIEW 深度加固：replaceYamlProvidersBlock 杜绝 String.replace 的 $&、$1、$ 等展开破坏", () => {
  const baseYaml = `agent-default-model:
  provider: default
  model: m1

providers: {
      old:
        {
          displayName: "old"
        }
    }

ui-onboarding:
  version: 1
`;

  // 替换块中包含形如 $&、$1、$' 的危险字符
  const trickyNewBlock = `providers: {
      dollar-test:
        {
          displayName: "Special $& Price $1 Offer $' Best",
          models: [
            { id: "model-$1-test" }
          ]
        }
    }`;

  const result = replaceYamlProvidersBlock(baseYaml, trickyNewBlock);

  // 必须精确保留字面量，绝不能发生展开
  assert.ok(result.includes('displayName: "Special $& Price $1 Offer $\' Best"'), "字面量 $& 严禁被解析替换");
  assert.ok(result.includes('{ id: "model-$1-test" }'), "字面量 $1 严禁被展开");
});

test("CODE_REVIEW R-05：生产替换函数忽略引号和注释内的大括号", () => {
  const oldYaml = String.raw`providers: {
  first: {
    displayName: "A}B",
    model: "{preview}"
  },
  # 此处的 } 是注释
  second: {
    displayName: 'Team''s } model',
    model: "escaped \" } quote"
  }
}
ui-onboarding:
  version: 1`;
  const newBlock = 'providers: { replacement: { displayName: "new" } }';

  const updated = replaceYamlProvidersBlock(oldYaml, newBlock);
  assert.strictEqual(updated, `${newBlock}\nui-onboarding:\n  version: 1`);
});

test("CODE_REVIEW R-05：大括号未闭合时拒绝替换已有配置", () => {
  const malformedYaml = 'providers: {\n  first: { displayName: "old" }';
  assert.throws(
    () => replaceYamlProvidersBlock(malformedYaml, "providers: {}"),
    /大括号未闭合/
  );
});
