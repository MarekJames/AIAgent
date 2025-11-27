"use client";
import { useState, useEffect } from "react";

export function TikTokPostButtons({ 
  clipId, 
  initialStatus 
}: { 
  clipId: string;
  initialStatus?: string | null;
}) {
  const [loading, setLoading] = useState<null | "draft" | "publish">(null);
  const [status, setStatus] = useState<string | null>(initialStatus || null);

  useEffect(() => {
    if (loading && (status === "draft" || status === "published" || status === "failed")) {
      setLoading(null);
    }
  }, [status, loading]);

  useEffect(() => {
    if (!loading) {
      return;
    }
    const interval = setInterval(async () => {
      const res = await fetch(`/api/tiktok/clip/${clipId}/status`);
      if (res.ok) {
        const data = await res.json();
        if (data.tiktokStatus) {
          setStatus(data.tiktokStatus);
        }
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [clipId, loading]);

  async function send(mode: "draft" | "publish") {
    setLoading(mode);
    setStatus(null);
    const res = await fetch(`/api/tiktok/clip/${clipId}/post`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    if (!res.ok) {
      setLoading(null);
      setStatus("failed");
    }
  }

  const getButtonText = (mode: "draft" | "publish") => {
    if (loading === mode) {
      if (status === "draft") {
        return "Saved as Draft!";
      }
      if (status === "published") {
        return "Published!";
      }
      if (status === "failed") {
        return "Failed";
      }
      return "Sending to TikTok...";
    }
    if (status === "draft" && mode === "draft") {
      return "Sent as Draft ✓";
    }
    if (status === "published" && mode === "publish") {
      return "Published ✓";
    }
    return mode === "draft" ? "Post as Draft" : "Publish";
  };

  const getButtonClass = (mode: "draft" | "publish") => {
    const base = "rounded-2xl px-3 py-2 border";
    if (loading === mode && (status === "draft" || status === "published")) {
      return `${base} bg-green-600 text-white border-green-600`;
    }
    if (loading === mode && status === "failed") {
      return `${base} bg-red-600 text-white border-red-600`;
    }
    if ((status === "draft" && mode === "draft") || (status === "published" && mode === "publish")) {
      return `${base} bg-green-600/20 border-green-600`;
    }
    return base;
  };

  return (
    <div className="flex gap-2">
      <button
        onClick={() => send("draft")}
        disabled={loading !== null}
        className={getButtonClass("draft")}
      >
        {getButtonText("draft")}
      </button>
      <button
        onClick={() => send("publish")}
        disabled={loading !== null}
        className={getButtonClass("publish")}
      >
        {getButtonText("publish")}
      </button>
    </div>
  );
}
