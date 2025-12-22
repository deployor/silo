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
                text: ":ms-wrench: Manage Keys",
                emoji: true,
              },
              value: `manage_keys:${bucket.id}`,
            },
            {
              text: {
                type: "plain_text",
                text: bucket.isPublic ? ":ms-shush: Make Private" : ":ms-globe: Make Public",
                emoji: true,
              },
              value: `toggle_public:${bucket.id}`,
            },
            {
              text: {
                type: "plain_text",
                text: ":angry-dino: Delete Bucket",
                emoji: true,
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
            text: `${bucket.isPublic ? ":ms-globe: Public" : ":ms-shush: Private"}  •  :ms-floppy-disk: ${formatBytes(bucket.totalBytes)}  •  ${bucket.totalRequests} reqs  •  Made on ${new Date(bucket.createdAt).toLocaleDateString()}`
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
          text: "Cargo (no clue what to call this still) Dashboard",
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
            type: "mrkdwn",
            text: "Howdy partner! :ms-cowhand:"
        }
      },
      {
        type: "actions",
        elements: [
            {
                type: "button",
                text: {
                    type: "plain_text",
                    text: ":lava-bucket: Create Bucket",
                    emoji: true
                },
                style: "primary",
                action_id: "open_create_bucket_modal"
            },
            {
                type: "button",
                text: {
                    type: "plain_text",
                    text: ":ms-arrows-clockwise: Refresh Stats",
                    emoji: true
                },
                action_id: "refresh_home"
            },
            {
                type: "button",
                text: {
                    type: "plain_text",
                    text: ":dinowow: Web Dashboard",
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
            text: "*:ms-increasing-graph: Usage Overview*"
        }
      },
      {
        type: "section",
        fields: [
            {
                type: "mrkdwn",
                text: `*Storage Used*\n${formatBytes(user.storageUsageBytes)} / ${formatBytes(user.storageLimitBytes)} (${usagePercent.toFixed(1)}%)`
            },
            {
                type: "mrkdwn",
                text: `*Active Buckets*\n${buckets.length} / 50`
            }
        ]
      },
      {
          type: "section",
          fields: [
              {
                  type: "mrkdwn",
                  text: `*Total Requests*\n${user.totalRequests.toLocaleString()}`
              },
              {
                  type: "mrkdwn",
                  text: `*Network Traffic*\n:ms-inbox: ${formatBytes(user.ingressBytes)}  :ms-outbox: ${formatBytes(user.egressBytes)}`
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
          text: `*:lava-bucket: Your Buckets (${buckets.length})*`,
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
            text: `Last updated: ${new Date().toLocaleTimeString()} :ms-tick:  |  <https://cargo.deployor.dev/docs|Documentation :ms-info:>`,
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
    text: "New Bucket :lava-bucket:",
    emoji: true,
  },
  submit: {
    type: "plain_text",
    text: "Confirm",
    emoji: true,
  },
  close: {
    type: "plain_text",
    text: "Cancel :byee:",
    emoji: true,
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
        emoji: true,
      },
      hint: {
        type: "plain_text",
        text: "Lowercase letters, numbers, and hyphens only. Keep it clean! :ms-wink:",
        emoji: true,
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
                    text: "Delete :angry-dino:",
                    emoji: true,
                },
                style: "danger",
                action_id: "delete_key",
                value: key.id,
                confirm: {
                    title: {
                        type: "plain_text",
                        text: "Delete Key? :panic:",
                        emoji: true,
                    },
                    text: {
                        type: "mrkdwn",
                        text: "Are you sure you want to delete this access key? This action cannot be undone. :floshed:"
                    },
                    confirm: {
                        type: "plain_text",
                        text: "Delete Key",
                        emoji: true,
                    },
                    deny: {
                        type: "plain_text",
                        text: "Keep It",
                        emoji: true,
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
                text: "Here are the keys :ms-wrench:"
            },
            accessory: {
                type: "button",
                text: {
                    type: "plain_text",
                    text: "Make New Key :blobby-lock:",
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
                text: `:yay: *New Key Made *\n\n*Access Key:*\n\`${newKey.accessKey}\`\n*Secret Key:*\n\`${newKey.secretKey}\`\n\n:ms-red-exclamation-mark: *Save this secret key now. It will only be shown to you here once!*`
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
                text: ":ms-concern: Keep your secret keys secret. Don't share them with strangers!"
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
            emoji: true,
        },
        close: {
            type: "plain_text",
            text: "Done",
            emoji: true,
        },
        blocks: blocks
    };
}

export const deleteBucketWarningModal = () => ({
    type: "modal",
    title: {
        type: "plain_text",
        text: "Whoa there! :ms-scared:",
        emoji: true,
    },
    close: {
        type: "plain_text",
        text: "Got it",
        emoji: true,
    },
    blocks: [
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: ":ms-stop-sign: *Hold your horses!*"
            }
        },
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: `For security, you gotta head over to the <https://${config.s3Domain}|web dashboard> to delete buckets. Safety first! :ms-cowhand:`
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
                text: "Peek :ms-raised-eyebrow:",
                emoji: true,
            },
            url: file.url,
            action_id: "open_file_url"
        }
    })) : [
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: "_This bucket is empty! :dino_waah:_"
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
                text: `_...and ${files.length - 20} more files. Check the dashboard for the full stash! :ms-bar-chart:_`
            }
        });
    }

    return {
        type: "modal",
        title: {
            type: "plain_text",
            text: `Stash: ${bucketName}`,
            emoji: true,
        },
        close: {
            type: "plain_text",
            text: "Done",
            emoji: true,
        },
        blocks: [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `Contents of *${bucketName}* :neofox_box:`
                }
            },
            {
                type: "divider"
            },
            ...displayBlocks
        ]
    };
};
