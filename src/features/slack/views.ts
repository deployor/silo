import { config } from "../../config";

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export const homeView = (user: any, buckets: any[]) => {
  const usagePercent = user.storageLimitBytes > 0
    ? (user.storageUsageBytes / user.storageLimitBytes) * 100
    : 0;

  const progressBar = (percent: number) => {
      const filled = Math.round(Math.min(percent, 100) / 10);
      const empty = 10 - filled;
      return "█".repeat(filled) + "░".repeat(empty);
  };

  const bucketBlocks = buckets.length > 0 ? buckets.map((bucket) => {
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${bucket.name}*`
        },
        accessory: {
          type: "overflow",
          options: [
            {
              text: {
                type: "plain_text",
                text: "Manage Keys",
              },
              value: `manage_keys:${bucket.id}`,
            },
            {
              text: {
                type: "plain_text",
                text: bucket.isPublic ? "Make Private" : "Make Public",
              },
              value: `toggle_public:${bucket.id}`,
            },
            {
              text: {
                type: "plain_text",
                text: "Delete Bucket",
              },
              value: `delete_bucket:${bucket.name}`,
            },
          ],
          action_id: "bucket_overflow_action",
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `${bucket.isPublic ? "🌍 Public" : "🔒 Private"}  •  📦 ${formatBytes(bucket.totalBytes)}  •  ⚡ ${bucket.totalRequests} reqs  •  📅 ${new Date(bucket.createdAt).toLocaleDateString()}`
          }
        ]
      },
      {
        type: "divider"
      }
    ];
  }).flat() : [
      {
          type: "section",
          text: {
              type: "mrkdwn",
              text: "_You don't have any buckets yet. Create one to get started!_"
          }
      },
      {
          type: "divider"
      }
  ];

  return {
    type: "home",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Cargo Control Center :ms-high-speed-train:",
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
            type: "mrkdwn",
            text: "Howdy partner! :ms-cowhand: Ready to ship some bits? Here's your stash stats and bucket brigade."
        }
      },
      {
        type: "actions",
        elements: [
            {
                type: "button",
                text: {
                    type: "plain_text",
                    text: ":ms-wrench: New Bucket",
                    emoji: true
                },
                style: "primary",
                action_id: "open_create_bucket_modal"
            },
            {
                type: "button",
                text: {
                    type: "plain_text",
                    text: ":ms-wink: Refresh",
                    emoji: true
                },
                action_id: "refresh_home"
            },
            {
                type: "button",
                text: {
                    type: "plain_text",
                    text: ":ms-globe: The Big Screen",
                    emoji: true
                },
                url: `https://${config.s3Domain}`,
                action_id: "open_web_dashboard"
            }
        ]
      },
      {
        type: "divider"
      },
      {
        type: "section",
        text: {
            type: "mrkdwn",
            text: "*:ms-bar-chart: The Stash Stats*"
        }
      },
      {
        type: "section",
        fields: [
            {
                type: "mrkdwn",
                text: `*Storage Space*\n${formatBytes(user.storageUsageBytes)} / ${formatBytes(user.storageLimitBytes)}\n\`${progressBar(usagePercent)}\``
            },
            {
                type: "mrkdwn",
                text: `*Bucket Count*\n${buckets.length} / 50 :ms-open-folder:`
            }
        ]
      },
      {
          type: "section",
          fields: [
              {
                  type: "mrkdwn",
                  text: `*Total Hits*\n${user.totalRequests.toLocaleString()} :ms-clap-hmn:`
              },
              {
                  type: "mrkdwn",
                  text: `*Traffic Flow*\n:ms-inbox: ${formatBytes(user.ingressBytes)}  :ms-outbox: ${formatBytes(user.egressBytes)}`
              }
          ]
      },
      {
        type: "divider"
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*:ms-cd: Your Buckets of Joy (${buckets.length})*`,
        }
      },
      {
        type: "divider",
      },
      ...bucketBlocks,
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Last checked: ${new Date().toLocaleTimeString()} :ms-tick:  |  <https://cargo.deployer.dev/docs|Read the Docs :ms-raised-eyebrow:>`,
          },
        ],
      },
    ],
  };
};

export const createBucketModal = () => ({
  type: "modal",
  callback_id: "create_bucket_submission",
  title: {
    type: "plain_text",
    text: "Create Bucket",
  },
  submit: {
    type: "plain_text",
    text: "Create",
  },
  close: {
    type: "plain_text",
    text: "Cancel",
  },
  blocks: [
    {
      type: "input",
      block_id: "bucket_name_block",
      element: {
        type: "plain_text_input",
        action_id: "bucket_name_input",
        placeholder: {
          type: "plain_text",
          text: "my-awesome-bucket",
        },
      },
      label: {
        type: "plain_text",
        text: "Bucket Name",
      },
      hint: {
        type: "plain_text",
        text: "Lowercase letters, numbers, and hyphens only.",
      },
    },
  ],
});

export const manageKeysModal = (bucket: any, keys: any[], newKey?: any) => {
    const keyBlocks = keys.map(key => [
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: `*Access Key:*\n\`${key.accessKey}\`\n*Secret Key:*\n\`${key.secretKey.substring(0, 4)}...${key.secretKey.substring(key.secretKey.length - 4)}\``
            },
            accessory: {
                type: "button",
                text: {
                    type: "plain_text",
                    text: "Delete",
                },
                style: "danger",
                action_id: "delete_key",
                value: key.id,
                confirm: {
                    title: {
                        type: "plain_text",
                        text: "Delete Key?"
                    },
                    text: {
                        type: "mrkdwn",
                        text: "Are you sure you want to delete this access key? This action cannot be undone."
                    },
                    confirm: {
                        type: "plain_text",
                        text: "Delete"
                    },
                    deny: {
                        type: "plain_text",
                        text: "Cancel"
                    }
                }
            }
        },
        {
            type: "divider"
        }
    ]).flat();

    const blocks: any[] = [
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: "Manage access keys for this bucket. These keys allow programmatic access."
            },
            accessory: {
                type: "button",
                text: {
                    type: "plain_text",
                    text: "Generate New Key",
                    emoji: true
                },
                style: "primary",
                action_id: "generate_key",
                value: bucket.id
            }
        },
        {
            type: "divider"
        }
    ];

    if (newKey) {
        blocks.push({
            type: "section",
            text: {
                type: "mrkdwn",
                text: `:white_check_mark: *New Key Generated*\n\n*Access Key:*\n\`${newKey.accessKey}\`\n*Secret Key:*\n\`${newKey.secretKey}\`\n\n:warning: *Save this secret key now. It will not be shown again.*`
            }
        });
        blocks.push({
            type: "divider"
        });
    }

    blocks.push(...keyBlocks);
    
    blocks.push({
        type: "context",
        elements: [
            {
                type: "mrkdwn",
                text: "⚠️ Keep your secret keys secure. Do not share them publicly."
            }
        ]
    });

    return {
        type: "modal",
        callback_id: "manage_keys_view",
        private_metadata: bucket.id, // Store bucket ID for refreshes
        title: {
            type: "plain_text",
            text: `Keys: ${bucket.name}`,
        },
        close: {
            type: "plain_text",
            text: "Close",
        },
        blocks: blocks
    };
}

export const deleteBucketWarningModal = () => ({
    type: "modal",
    title: {
        type: "plain_text",
        text: "Delete Bucket"
    },
    close: {
        type: "plain_text",
        text: "Close"
    },
    blocks: [
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: ":warning: *For security reasons, buckets cannot be deleted from Slack.*"
            }
        },
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: `Please visit the <https://${config.s3Domain}|web dashboard> to delete your buckets.`
            }
        }
    ]
});

export const filesModal = (bucketName: string, files: any[]) => {
    const fileBlocks = files.length > 0 ? files.map(file => ({
        type: "section",
        text: {
            type: "mrkdwn",
            text: `*${file.name}*\n${formatBytes(file.size)} • ${new Date(file.lastModified).toLocaleDateString()}`
        },
        accessory: {
            type: "button",
            text: {
                type: "plain_text",
                text: "Open",
            },
            url: file.url,
            action_id: "open_file_url"
        }
    })) : [
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: "_No files found in this bucket._"
            }
        }
    ];

    // Slack modals have a limit of 100 blocks. We'll show the first 20 files to be safe.
    const displayBlocks = fileBlocks.slice(0, 20);
    if (files.length > 20) {
        displayBlocks.push({
            type: "section",
            text: {
                type: "mrkdwn",
                text: `_...and ${files.length - 20} more files. View all in the dashboard._`
            }
        });
    }

    return {
        type: "modal",
        title: {
            type: "plain_text",
            text: `Files: ${bucketName}`
        },
        close: {
            type: "plain_text",
            text: "Close"
        },
        blocks: [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `Files in *${bucketName}*:`
                }
            },
            {
                type: "divider"
            },
            ...displayBlocks
        ]
    };
};
