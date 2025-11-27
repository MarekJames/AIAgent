export interface YoutubeComment {
  text: string;
  timestamp?: number;
  likeCount: number;
}

export async function fetchVideoComments(
  videoId: string,
  maxResults: number = 100
): Promise<YoutubeComment[]> {
  const apiKey = process.env.YOUTUBE_API_KEY;

  if (!apiKey) {
    console.log("YouTube API key not configured, skipping comment fetching");
    return [];
  }

  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/commentThreads");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("videoId", videoId);
    url.searchParams.set("maxResults", String(Math.min(maxResults, 100)));
    url.searchParams.set("order", "relevance");
    url.searchParams.set("textFormat", "plainText");
    url.searchParams.set("key", apiKey);

    const response = await fetch(url.toString());

    if (response.status === 403) {
      const errorData = await response.json();
      if (errorData.error?.errors?.[0]?.reason === "commentsDisabled") {
        console.log("Comments are disabled for this video");
        return [];
      }
      throw new Error(`YouTube API forbidden: ${JSON.stringify(errorData)}`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`YouTube API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const comments: YoutubeComment[] = [];

    for (const item of data.items || []) {
      const snippet = item.snippet?.topLevelComment?.snippet;
      if (snippet?.textDisplay) {
        comments.push({
          text: snippet.textDisplay,
          likeCount: snippet.likeCount || 0,
        });
      }
    }

    console.log(`Fetched ${comments.length} comments for video ${videoId}`);
    return comments;
  } catch (error) {
    console.error("Failed to fetch YouTube comments:", error);
    return [];
  }
}

export function extractVideoIdFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);

    if (urlObj.hostname.includes("youtube.com")) {
      return urlObj.searchParams.get("v");
    }

    if (urlObj.hostname === "youtu.be") {
      return urlObj.pathname.slice(1);
    }

    return null;
  } catch {
    return null;
  }
}
