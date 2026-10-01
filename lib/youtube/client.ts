import { createReadStream } from "node:fs";
import { google } from "googleapis";

function getOAuthClient() {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI;
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !redirectUri || !refreshToken) {
    throw new Error(
      "YouTube OAuth environment variables are incomplete."
    );
  }

  const auth = new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri
  );
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

export async function uploadYouTubeVideo(input: {
  filePath: string;
  title: string;
  description: string;
  tags?: string[];
  privacyStatus?: "private" | "unlisted" | "public";
}) {
  const youtube = google.youtube({
    version: "v3",
    auth: getOAuthClient()
  });

  const response = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: input.title,
        description: input.description,
        tags: input.tags,
        categoryId: "28"
      },
      status: {
        privacyStatus: input.privacyStatus ?? "private"
      }
    },
    media: {
      body: createReadStream(input.filePath)
    }
  });

  return response.data;
}
