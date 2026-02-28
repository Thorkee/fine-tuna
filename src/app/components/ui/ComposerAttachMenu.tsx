"use client";

import { Github, Link2, Upload } from "lucide-react";
import type { ReactNode } from "react";

type AttachAction = {
  id: "upload" | "github" | "huggingface";
  label: string;
  description: string;
  onClick: () => void;
  icon: ReactNode;
};

export default function ComposerAttachMenu(props: {
  open: boolean;
  isDark?: boolean;
  onUploadFiles: () => void;
  onConnectGithub: () => void;
  onConnectHuggingFace: () => void;
}) {
  const { open, isDark = false, onUploadFiles, onConnectGithub, onConnectHuggingFace } = props;
  if (!open) return null;

  const actions: AttachAction[] = [
    {
      id: "upload",
      label: "Upload files",
      description: "Attach local files to this chat.",
      onClick: onUploadFiles,
      icon: <Upload className="w-4 h-4" />,
    },
    {
      id: "github",
      label: "Connect to GitHub",
      description: "Manage GitHub integration tokens.",
      onClick: onConnectGithub,
      icon: <Github className="w-4 h-4" />,
    },
    {
      id: "huggingface",
      label: "Connect to HuggingFace",
      description: "Manage Hugging Face integration tokens.",
      onClick: onConnectHuggingFace,
      icon: <Link2 className="w-4 h-4" />,
    },
  ];

  return (
    <div
      className="absolute z-50 left-0 bottom-full mb-2 w-72 rounded-2xl border border-default p-2 shadow-xl backdrop-blur bg-[hsl(var(--bg-elevated)/0.95)] text-primary"
      role="menu"
      aria-label="Attachment actions"
    >
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          onClick={action.onClick}
          className="w-full text-left rounded-xl px-3 py-2.5 transition-colors hover:bg-tertiary"
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5 text-secondary">{action.icon}</div>
            <div className="min-w-0">
              <div className="text-sm font-medium">{action.label}</div>
              <div className="text-xs mt-0.5 text-muted">{action.description}</div>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

