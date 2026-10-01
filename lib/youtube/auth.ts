export function isYoutubeClientConfigured() {
  return Boolean(
    process.env.YOUTUBE_CLIENT_ID &&
      process.env.YOUTUBE_CLIENT_SECRET &&
      process.env.YOUTUBE_REDIRECT_URI
  );
}

export function isYoutubeConnected() {
  return Boolean(
    isYoutubeClientConfigured() &&
      process.env.YOUTUBE_REFRESH_TOKEN
  );
}
