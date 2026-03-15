/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  docs: [
    'intro',
    {
      type: 'category',
      label: 'Features',
      collapsed: false,
      items: [
        'features/agents',
        'features/preview',
        'features/github',
        'features/git',
        'features/databases',
        'features/containers',
        'features/file-editor',
        'features/terminal',
        'features/ssh',
        'features/serial',
        'features/reverse-proxy',
        'features/authentication',
      ],
    },
    {
      type: 'category',
      label: 'Deployment',
      items: [
        'deployment/npm',
        'deployment/docker',
        'deployment/lxc',
        'deployment/proxmox',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      items: [
        'reference/mcp-tools',
        'reference/session-event-schema',
      ],
    },
  ],
};

module.exports = sidebars;
