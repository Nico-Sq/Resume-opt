import type { ReactElement } from 'react';

export type EditorIconName =
  | 'arrow-left'
  | 'award'
  | 'basic'
  | 'campus'
  | 'check-circle'
  | 'chevron-left'
  | 'chevron-right'
  | 'design'
  | 'diagnosis'
  | 'download'
  | 'education'
  | 'export'
  | 'intent'
  | 'internship'
  | 'layout'
  | 'modules'
  | 'more'
  | 'pencil'
  | 'plus'
  | 'project'
  | 'redo'
  | 'self-evaluation'
  | 'share'
  | 'skills'
  | 'sort'
  | 'summary'
  | 'template'
  | 'typography'
  | 'undo'
  | 'work';

export function EditorIcon({
  name,
  size = 22,
}: {
  name: EditorIconName;
  size?: number;
}): ReactElement {
  const common = {
    'aria-hidden': true,
    fill: 'none',
    height: size,
    viewBox: '0 0 24 24',
    width: size,
  } as const;
  const stroke = {
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: 1.8,
  };

  switch (name) {
    case 'arrow-left':
      return (
        <svg {...common}>
          <path d="m15 18-6-6 6-6M9 12h11" {...stroke} />
        </svg>
      );
    case 'check-circle':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" {...stroke} />
          <path d="m8.4 12 2.3 2.3 4.9-5" {...stroke} />
        </svg>
      );
    case 'pencil':
      return (
        <svg {...common}>
          <path d="m4 20 4.2-.9L19 8.3 15.7 5 4.9 15.8 4 20ZM13.9 6.8l3.3 3.3" {...stroke} />
        </svg>
      );
    case 'undo':
      return (
        <svg {...common}>
          <path d="M9 7 5 11l4 4M5 11h8a6 6 0 0 1 6 6" {...stroke} />
        </svg>
      );
    case 'redo':
      return (
        <svg {...common}>
          <path d="m15 7 4 4-4 4m4-4h-8a6 6 0 0 0-6 6" {...stroke} />
        </svg>
      );
    case 'share':
      return (
        <svg {...common}>
          <circle cx="18" cy="5" r="2" {...stroke} />
          <circle cx="6" cy="12" r="2" {...stroke} />
          <circle cx="18" cy="19" r="2" {...stroke} />
          <path d="m8 11 8-5M8 13l8 5" {...stroke} />
        </svg>
      );
    case 'download':
    case 'export':
      return (
        <svg {...common}>
          <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 15v5h14v-5" {...stroke} />
        </svg>
      );
    case 'chevron-left':
      return (
        <svg {...common}>
          <path d="m14 7-5 5 5 5" {...stroke} />
        </svg>
      );
    case 'chevron-right':
      return (
        <svg {...common}>
          <path d="m10 7 5 5-5 5" {...stroke} />
        </svg>
      );
    case 'basic':
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="3" {...stroke} />
          <path d="M5 21v-2a7 7 0 0 1 14 0v2H5Z" {...stroke} />
        </svg>
      );
    case 'intent':
    case 'diagnosis':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" {...stroke} />
          <circle cx="12" cy="12" r="3" {...stroke} />
          <path d="m17.7 6.3 2-2m-2 0h2v2" {...stroke} />
        </svg>
      );
    case 'summary':
    case 'self-evaluation':
      return (
        <svg {...common}>
          <rect height="17" rx="1.5" width="15" x="4.5" y="3.5" {...stroke} />
          <path d="M8 8h8M8 12h8M8 16h5" {...stroke} />
        </svg>
      );
    case 'education':
      return (
        <svg {...common}>
          <path d="m3 9 9-5 9 5-9 5-9-5Z" {...stroke} />
          <path d="M6 11.5V16c3.4 2.3 8.6 2.3 12 0v-4.5M21 9v6" {...stroke} />
        </svg>
      );
    case 'work':
    case 'project':
    case 'internship':
      return (
        <svg {...common}>
          <rect height="13" rx="1.5" width="18" x="3" y="7" {...stroke} />
          <path d="M9 7V4h6v3M3 12h18M10 12v2h4v-2" {...stroke} />
        </svg>
      );
    case 'campus':
      return (
        <svg {...common}>
          <path d="M4 21V8h8v13M12 12h8v9M7 11h2m-2 4h2m-2 4h2m8-4h2m-2 4h2M2 21h20" {...stroke} />
        </svg>
      );
    case 'skills':
      return (
        <svg {...common}>
          <path
            d="m12 3 2.2 3.2 3.8.3-.3 3.8 2.8 2.7-2.8 2.7.3 3.8-3.8.3L12 23l-2.2-3.2-3.8-.3.3-3.8L3.5 13l2.8-2.7L6 6.5l3.8-.3L12 3Z"
            {...stroke}
          />
          <circle cx="12" cy="13" r="3" {...stroke} />
        </svg>
      );
    case 'award':
      return (
        <svg {...common}>
          <circle cx="12" cy="9" r="5" {...stroke} />
          <path d="m9 13-2 8 5-3 5 3-2-8" {...stroke} />
        </svg>
      );
    case 'template':
      return (
        <svg {...common}>
          <rect height="18" rx="1.5" width="15" x="4.5" y="3" {...stroke} />
          <path d="M8 7h8M8 11h8M8 15h5" {...stroke} />
        </svg>
      );
    case 'modules':
      return (
        <svg {...common}>
          <rect height="6" rx="1" width="6" x="3" y="3" {...stroke} />
          <rect height="6" rx="1" width="6" x="15" y="3" {...stroke} />
          <rect height="6" rx="1" width="6" x="3" y="15" {...stroke} />
          <rect height="6" rx="1" width="6" x="15" y="15" {...stroke} />
        </svg>
      );
    case 'layout':
      return (
        <svg {...common}>
          <rect height="16" rx="1.5" width="18" x="3" y="4" {...stroke} />
          <path d="M9 4v16m0-10h12" {...stroke} />
        </svg>
      );
    case 'typography':
      return (
        <svg {...common}>
          <path d="M5 5h14M12 5v15M8 20h8" {...stroke} />
        </svg>
      );
    case 'design':
      return (
        <svg {...common}>
          <path d="m14.5 4.5 5 5L9 20H4v-5L14.5 4.5ZM12 7l5 5" {...stroke} />
        </svg>
      );
    case 'sort':
      return (
        <svg {...common}>
          <path d="M8 7h12M8 12h9M8 17h6M4 6v12m0 0-2-2m2 2 2-2" {...stroke} />
        </svg>
      );
    case 'plus':
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" {...stroke} />
        </svg>
      );
    case 'more':
      return (
        <svg {...common}>
          <circle cx="5" cy="12" r="1" fill="currentColor" />
          <circle cx="12" cy="12" r="1" fill="currentColor" />
          <circle cx="19" cy="12" r="1" fill="currentColor" />
        </svg>
      );
  }
}
