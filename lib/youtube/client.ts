import { google } from "googleapis";
import { openRenderedVideo, YoutubeUploadError, uploadFailure } from "./upload-validation";

function getOAuthClient() {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI;
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !redirectUri || !refreshToken) {
    throw new YoutubeUploadError(
      "YOUTUBE_UPLOAD_NOT_CONFIGURED",
      "웹 업로드용 YouTube OAuth 설정이 없습니다. 데스크톱의 읽기 전용 로그인과 별도로 업로드 권한이 있는 계정을 연결하세요.",
      503
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
  const auth = getOAuthClient();
  const file = await openRenderedVideo(input.filePath);
  const stream = file.createReadStream({ start: 0, autoClose: false });
  stream.on("error", () => {});
  try {
    const youtube = google.youtube({ version: "v3", auth });
    const response = await youtube.videos.insert({
    notifySubscribers: false,
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
      mimeType: "video/mp4",
      body: stream
    }
  }, { retry: false, timeout: 180000 });

    if (!response.data.id || !/^[A-Za-z0-9_-]{11}$/.test(response.data.id)) {
      throw new YoutubeUploadError("YOUTUBE_UPLOAD_UNCONFIRMED", "YouTube에서 업로드 ID를 받지 못했습니다. 중복 게시 방지를 위해 채널을 확인하세요.", 502);
    }
    return response.data;
  } catch (error) {
    throw uploadFailure(error);
  } finally {
    stream.destroy();
    await file.close().catch(() => {});
  }
}
