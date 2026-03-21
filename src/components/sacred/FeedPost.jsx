import React from "react";
import { MessageCircle, Heart, Share2 } from "lucide-react";
import { classNames as cx } from "@/utils/css";
import Avatar from "./Avatar";

function StatPill({ icon, value, label }) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition-all duration-200 hover:-translate-y-0.5 hover:border-indigo-200 hover:text-indigo-700"
      aria-label={`${value} ${label}`}
    >
      {icon}
      <span>{value}</span>
    </button>
  );
}

export default function FeedPost({
  author,
  avatarUrl,
  household = false,
  content,
  timestamp,
  likes = 0,
  comments = 0,
  shares = 0,
  mediaUrl,
  className,
}) {
  return (
    <article
      className={cx(
        "rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_8px_24px_rgba(15,23,42,0.06)] transition-all duration-300 hover:-translate-y-1 hover:scale-[1.01] hover:shadow-[0_18px_36px_rgba(16,185,129,0.14)]",
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <Avatar
          name={author}
          imageUrl={avatarUrl}
          type={household ? "household" : "user"}
          subtitle={timestamp}
          size="md"
          online
        />
      </div>

      <p className="font-sans mt-4 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
        {content}
      </p>

      {mediaUrl ? (
        <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
          <img src={mediaUrl} alt="post media" className="h-52 w-full object-cover transition-transform duration-300 hover:scale-[1.02]" />
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <StatPill icon={<Heart className="h-3.5 w-3.5" />} value={likes} label="likes" />
        <StatPill icon={<MessageCircle className="h-3.5 w-3.5" />} value={comments} label="comments" />
        <StatPill icon={<Share2 className="h-3.5 w-3.5" />} value={shares} label="shares" />
      </div>
    </article>
  );
}
