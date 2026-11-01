// 自動生成: pnpm --filter @agent-orchestrator/contracts run gen:schemas（編集しない）
// 元: packages/contracts/schemas/*.schema.json
export const EMBEDDED_SCHEMAS: Record<string, Record<string, unknown>> = {
  "contradiction.schema.json": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "Requirements Contradictions v1",
    "description": "Requirements Agent が task 素案の確定前に行う矛盾検出の出力。要件同士、要件と既存コード・設定（lint ルール、型設定、既存実装）の矛盾を列挙する。",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "contradictions"
    ],
    "properties": {
      "contradictions": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "kind",
            "severity",
            "description",
            "evidence",
            "options",
            "recommendation"
          ],
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1
            },
            "kind": {
              "enum": [
                "requirement_vs_requirement",
                "requirement_vs_project"
              ]
            },
            "severity": {
              "enum": [
                "blocking",
                "minor"
              ]
            },
            "description": {
              "type": "string",
              "minLength": 1
            },
            "evidence": {
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1
              }
            },
            "options": {
              "type": "array",
              "minItems": 2,
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "value",
                  "label",
                  "consequence"
                ],
                "properties": {
                  "value": {
                    "type": "string",
                    "minLength": 1
                  },
                  "label": {
                    "type": "string",
                    "minLength": 1
                  },
                  "consequence": {
                    "type": "string",
                    "minLength": 1
                  }
                }
              }
            },
            "recommendation": {
              "type": "string"
            }
          }
        }
      }
    }
  },
  "interview.schema.json": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "Requirements Interview v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "facts",
      "questions",
      "blockingQuestions",
      "summary"
    ],
    "properties": {
      "facts": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "key",
            "value",
            "source",
            "confidence"
          ],
          "properties": {
            "key": {
              "type": "string"
            },
            "value": {
              "type": "string"
            },
            "source": {
              "type": "string"
            },
            "confidence": {
              "enum": [
                "confirmed",
                "inferred",
                "unknown"
              ]
            }
          }
        }
      },
      "questions": {
        "type": "array",
        "maxItems": 3,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "question",
            "decisionImpact",
            "options",
            "recommendation"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "question": {
              "type": "string",
              "minLength": 1
            },
            "decisionImpact": {
              "enum": [
                "blocking",
                "non_blocking"
              ]
            },
            "options": {
              "type": "array",
              "items": {
                "type": "object",
                "required": [
                  "value",
                  "label"
                ],
                "additionalProperties": false,
                "properties": {
                  "value": {
                    "type": "string"
                  },
                  "label": {
                    "type": "string"
                  }
                }
              }
            },
            "recommendation": {
              "type": "string"
            }
          }
        }
      },
      "blockingQuestions": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "summary": {
        "type": "string"
      }
    }
  },
  "ipc.schema.json": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "IPC Wire Protocol v1",
    "oneOf": [
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "method",
          "params"
        ],
        "properties": {
          "id": {
            "type": "string"
          },
          "method": {
            "enum": [
              "environment.check",
              "project.inspect",
              "draft.create",
              "draft.answer",
              "draft.revise",
              "draft.approve",
              "run.start",
              "run.cancel",
              "run.status",
              "run.list",
              "run.report"
            ]
          },
          "params": {
            "type": "object"
          }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "ok"
        ],
        "properties": {
          "id": {
            "type": "string"
          },
          "ok": {
            "type": "boolean"
          },
          "result": {},
          "error": {
            "type": "object",
            "required": [
              "code",
              "message"
            ],
            "properties": {
              "code": {
                "type": "string"
              },
              "message": {
                "type": "string"
              }
            }
          }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "event",
          "payload"
        ],
        "properties": {
          "event": {
            "type": "string"
          },
          "runId": {
            "type": "string"
          },
          "payload": {
            "type": "object"
          }
        }
      }
    ]
  },
  "review.schema.json": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "Codex Review v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "verdict",
      "findings",
      "requirementsUnverified",
      "summary"
    ],
    "properties": {
      "verdict": {
        "enum": [
          "approved",
          "changes_requested",
          "unknown"
        ]
      },
      "findings": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "severity",
            "file",
            "line",
            "description",
            "evidence",
            "recommendation"
          ],
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1
            },
            "severity": {
              "enum": [
                "critical",
                "high",
                "medium",
                "low"
              ]
            },
            "file": {
              "type": "string",
              "minLength": 1
            },
            "line": {
              "type": "integer",
              "minimum": 1
            },
            "description": {
              "type": "string",
              "minLength": 1
            },
            "evidence": {
              "type": "string",
              "minLength": 1
            },
            "recommendation": {
              "type": "string",
              "minLength": 1
            }
          }
        }
      },
      "requirementsUnverified": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1
        }
      },
      "summary": {
        "type": "string",
        "minLength": 1
      }
    }
  },
  "task-proposal.schema.json": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "Task Proposal v1",
    "description": "Requirements Agent が blockingQuestions=[] 到達後に生成する task.yaml の素案。repository/baseRef/verificationProfile/limits は Orchestrator が付与する。",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "title",
      "objective",
      "requirements",
      "outOfScope",
      "approach",
      "acceptanceCriteria",
      "openItems"
    ],
    "properties": {
      "title": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "objective": {
        "type": "string",
        "minLength": 1
      },
      "requirements": {
        "type": "array",
        "minItems": 1,
        "items": {
          "type": "string",
          "minLength": 1
        }
      },
      "outOfScope": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1
        }
      },
      "approach": {
        "type": "string",
        "minLength": 1
      },
      "acceptanceCriteria": {
        "type": "array",
        "minItems": 1,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "given",
            "when",
            "then"
          ],
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1
            },
            "given": {
              "type": "string",
              "minLength": 1
            },
            "when": {
              "type": "string",
              "minLength": 1
            },
            "then": {
              "type": "string",
              "minLength": 1
            }
          }
        }
      },
      "openItems": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1
        }
      }
    }
  },
  "task.schema.json": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "Approved Task v2",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "id",
      "title",
      "repository",
      "baseRef",
      "requirements",
      "acceptanceCriteria",
      "verificationProfile"
    ],
    "properties": {
      "schemaVersion": {
        "const": 2
      },
      "id": {
        "type": "string",
        "minLength": 1
      },
      "title": {
        "type": "string",
        "minLength": 1
      },
      "repository": {
        "type": "string",
        "minLength": 1
      },
      "baseRef": {
        "type": "string",
        "minLength": 1
      },
      "requirements": {
        "type": "array",
        "minItems": 1,
        "items": {
          "type": "string",
          "minLength": 1
        }
      },
      "acceptanceCriteria": {
        "type": "array",
        "minItems": 1,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "given",
            "when",
            "then"
          ],
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1
            },
            "given": {
              "type": "string",
              "minLength": 1
            },
            "when": {
              "type": "string",
              "minLength": 1
            },
            "then": {
              "type": "string",
              "minLength": 1
            }
          }
        }
      },
      "verificationProfile": {
        "enum": [
          "node-pnpm"
        ]
      },
      "limits": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "maxImplementationAttempts": {
            "type": "integer",
            "minimum": 1,
            "maximum": 3,
            "default": 3
          },
          "maxDurationSeconds": {
            "type": "integer",
            "minimum": 60,
            "default": 2700
          },
          "cliTimeoutSeconds": {
            "type": "integer",
            "minimum": 1,
            "default": 900
          },
          "verificationTimeoutSeconds": {
            "type": "integer",
            "minimum": 1,
            "default": 300
          }
        }
      },
      "review": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "blockingSeverities": {
            "type": "array",
            "uniqueItems": true,
            "items": {
              "enum": [
                "critical",
                "high",
                "medium",
                "low"
              ]
            },
            "default": [
              "critical",
              "high"
            ]
          }
        }
      }
    }
  }
};
