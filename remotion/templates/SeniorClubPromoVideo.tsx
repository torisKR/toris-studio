import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig
} from "remotion";
import { Audio } from "@remotion/media";
import type { CSSProperties, ReactNode } from "react";

const BRAND = {
  green: "#0E5142",
  greenDark: "#083C31",
  coral: "#F28A54",
  sky: "#54ACC9",
  cream: "#F7F4EC",
  text: "#18312B",
  soft: "#51645F"
};

const phoneStyle: CSSProperties = {
  width: 430,
  borderRadius: 42,
  overflow: "hidden",
  boxShadow: "0 34px 90px rgba(8,60,49,.24)",
  border: "10px solid rgba(255,255,255,.92)",
  background: "#fff"
};

function Fade({ children }: { children: ReactNode }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({
    frame,
    fps,
    config: { damping: 19, stiffness: 130, mass: 0.9 }
  });
  return (
    <div
      style={{
        opacity: interpolate(enter, [0, 1], [0, 1]),
        transform: `translateY(${interpolate(enter, [0, 1], [42, 0])}px)`
      }}
    >
      {children}
    </div>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        position: "absolute",
        left: 58,
        right: 58,
        bottom: 104,
        display: "flex",
        justifyContent: "center",
        zIndex: 20
      }}
    >
      <div
        style={{
          padding: "17px 24px",
          borderRadius: 18,
          background: "rgba(11,24,21,.84)",
          color: "#fff",
          fontSize: 31,
          lineHeight: 1.38,
          fontWeight: 760,
          textAlign: "center",
          letterSpacing: "-.025em",
          boxShadow: "0 18px 50px rgba(0,0,0,.22)"
        }}
      >
        {children}
      </div>
    </div>
  );
}

function HeaderMark() {
  return (
    <div
      style={{
        position: "absolute",
        top: 54,
        left: 56,
        right: 56,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        zIndex: 15
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <Img
          src={staticFile("senior-club/logo.png")}
          style={{ width: 54, height: 54, objectFit: "contain" }}
        />
        <span
          style={{
            color: BRAND.text,
            fontSize: 24,
            fontWeight: 850,
            letterSpacing: "-.025em"
          }}
        >
          시니어클럽
        </span>
      </div>
      <span
        style={{
          color: BRAND.soft,
          fontSize: 18,
          fontWeight: 700,
          letterSpacing: ".08em"
        }}
      >
        좋아하는 일을 함께
      </span>
    </div>
  );
}

function HeroScene() {
  const frame = useCurrentFrame();
  const zoom = interpolate(frame, [0, 120], [1.06, 1], {
    extrapolateRight: "clamp"
  });

  return (
    <AbsoluteFill style={{ background: BRAND.cream, overflow: "hidden" }}>
      <Img
        src={staticFile("senior-club/hero.jpg")}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${zoom})`
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(180deg, rgba(8,60,49,.08) 0%, rgba(8,60,49,.2) 38%, rgba(8,34,28,.88) 100%)"
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 62,
          right: 62,
          bottom: 260,
          color: "#fff"
        }}
      >
        <Fade>
          <div
            style={{
              display: "inline-flex",
              padding: "11px 16px",
              borderRadius: 999,
              background: "rgba(255,255,255,.16)",
              border: "1px solid rgba(255,255,255,.25)",
              fontSize: 21,
              fontWeight: 800,
              marginBottom: 24
            }}
          >
            목적 → 사람 → 활동 → 관계
          </div>
          <h1
            style={{
              margin: 0,
              fontSize: 78,
              lineHeight: 1.08,
              letterSpacing: "-.055em",
              fontWeight: 900,
              wordBreak: "keep-all"
            }}
          >
            좋아하는 일을 함께할 사람,
            <br />
            어디서 찾고 계신가요?
          </h1>
        </Fade>
      </div>
      <Caption>좋아하는 일을 함께할 사람, 어디서 찾고 계신가요?</Caption>
    </AbsoluteFill>
  );
}

function DiscoverScene() {
  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(circle at 80% 15%, rgba(84,172,201,.18), transparent 28%), #F7FBF9",
        color: BRAND.text,
        padding: "150px 58px 190px",
        overflow: "hidden"
      }}
    >
      <HeaderMark />
      <Fade>
        <div style={{ color: BRAND.green, fontSize: 22, fontWeight: 850 }}>
          01 · 내게 맞는 모임 찾기
        </div>
        <h2
          style={{
            margin: "18px 0 0",
            fontSize: 64,
            lineHeight: 1.1,
            letterSpacing: "-.05em",
            fontWeight: 900
          }}
        >
          관심사와 지역으로
          <br />
          편하게 찾아보세요
        </h2>
      </Fade>

      <div
        style={{
          position: "absolute",
          left: 54,
          right: 54,
          top: 500,
          height: 990
        }}
      >
        <Img
          src={staticFile("senior-club/home.png")}
          style={{
            ...phoneStyle,
            position: "absolute",
            left: 0,
            top: 36,
            transform: "rotate(-3deg)"
          }}
        />
        <Img
          src={staticFile("senior-club/events.png")}
          style={{
            ...phoneStyle,
            position: "absolute",
            right: 0,
            top: 0,
            transform: "rotate(3deg)"
          }}
        />
      </div>
      <Caption>관심사와 지역에 맞는 모임을 한눈에 찾고</Caption>
    </AbsoluteFill>
  );
}

function DetailScene() {
  const chips = ["날짜", "장소", "난이도", "참가비"];
  return (
    <AbsoluteFill
      style={{
        background: BRAND.green,
        color: "#fff",
        padding: "150px 58px 190px",
        overflow: "hidden"
      }}
    >
      <div
        style={{
          position: "absolute",
          width: 640,
          height: 640,
          borderRadius: "50%",
          background: BRAND.sky,
          filter: "blur(180px)",
          opacity: 0.18,
          right: -260,
          top: 160
        }}
      />
      <Fade>
        <div style={{ color: "#BCE7D9", fontSize: 22, fontWeight: 850 }}>
          02 · 신청 전에 먼저 확인
        </div>
        <h2
          style={{
            margin: "18px 0 0",
            fontSize: 64,
            lineHeight: 1.1,
            letterSpacing: "-.05em",
            fontWeight: 900
          }}
        >
          필요한 정보는
          <br />
          한 화면에서
        </h2>
      </Fade>

      <Img
        src={staticFile("senior-club/detail.png")}
        style={{
          ...phoneStyle,
          position: "absolute",
          left: 70,
          top: 505,
          width: 500,
          borderColor: "rgba(255,255,255,.96)",
          boxShadow: "0 36px 90px rgba(0,0,0,.28)"
        }}
      />

      <div
        style={{
          position: "absolute",
          right: 62,
          top: 600,
          width: 390,
          display: "grid",
          gap: 20
        }}
      >
        {chips.map((chip, index) => (
          <div
            key={chip}
            style={{
              padding: "26px 28px",
              borderRadius: 22,
              background:
                index === chips.length - 1
                  ? BRAND.coral
                  : "rgba(255,255,255,.1)",
              border: "1px solid rgba(255,255,255,.16)",
              fontSize: 32,
              fontWeight: 850
            }}
          >
            {chip}
          </div>
        ))}
      </div>
      <Caption>날짜와 장소, 난이도와 참가비를 확인한 뒤</Caption>
    </AbsoluteFill>
  );
}

function ApplyScene() {
  return (
    <AbsoluteFill
      style={{
        background: "#FFF9F5",
        color: BRAND.text,
        padding: "150px 58px 190px",
        overflow: "hidden"
      }}
    >
      <HeaderMark />
      <Fade>
        <div style={{ color: BRAND.coral, fontSize: 22, fontWeight: 850 }}>
          03 · 신청부터 상태 확인까지
        </div>
        <h2
          style={{
            margin: "18px 0 0",
            fontSize: 64,
            lineHeight: 1.1,
            letterSpacing: "-.05em",
            fontWeight: 900
          }}
        >
          휴대폰 인증으로 신청하고,
          <br />
          상태도 분명하게
        </h2>
      </Fade>

      <Img
        src={staticFile("senior-club/apply.png")}
        style={{
          ...phoneStyle,
          position: "absolute",
          left: 54,
          top: 510,
          transform: "rotate(-3deg)"
        }}
      />
      <Img
        src={staticFile("senior-club/pending.png")}
        style={{
          ...phoneStyle,
          position: "absolute",
          right: 54,
          top: 560,
          transform: "rotate(3deg)"
        }}
      />

      <Caption>휴대폰 인증으로 편하게 신청하고, 진행 상태도 확인하세요</Caption>
    </AbsoluteFill>
  );
}

function ClosingScene() {
  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(circle at 50% 20%, rgba(84,172,201,.22), transparent 30%), linear-gradient(180deg,#F6FBF8 0%,#E7F3ED 100%)",
        color: BRAND.text,
        display: "grid",
        placeItems: "center",
        padding: "90px 64px",
        textAlign: "center"
      }}
    >
      <Fade>
        <Img
          src={staticFile("senior-club/logo.png")}
          style={{ width: 170, height: 170, objectFit: "contain", margin: "0 auto 34px" }}
        />
        <div
          style={{
            color: BRAND.green,
            fontSize: 24,
            fontWeight: 850,
            letterSpacing: ".08em"
          }}
        >
          시니어클럽
        </div>
        <h2
          style={{
            margin: "20px 0 0",
            fontSize: 74,
            lineHeight: 1.08,
            fontWeight: 900,
            letterSpacing: "-.055em"
          }}
        >
          좋아하는 일을 함께,
          <br />
          다음 약속까지
        </h2>
        <p
          style={{
            margin: "34px auto 0",
            maxWidth: 820,
            fontSize: 31,
            lineHeight: 1.5,
            color: BRAND.soft,
            fontWeight: 650
          }}
        >
          등산 · 사진 · 원예 · 클래식
          <br />
          내가 좋아하는 주제로 사람을 만나세요.
        </p>
        <div
          style={{
            margin: "46px auto 0",
            display: "inline-flex",
            padding: "18px 28px",
            borderRadius: 999,
            background: BRAND.green,
            color: "#fff",
            fontSize: 27,
            fontWeight: 850
          }}
        >
          목적 → 사람 → 활동 → 관계
        </div>
      </Fade>
      <Caption>한 번의 활동이 다음 약속으로 이어지도록. 시니어클럽.</Caption>
    </AbsoluteFill>
  );
}

export function SeniorClubPromoVideo() {
  return (
    <AbsoluteFill style={{ fontFamily: '"Pretendard Variable", Pretendard, sans-serif' }}>
      <Sequence from={0} durationInFrames={155}>
        <HeroScene />
      </Sequence>
      <Sequence from={155} durationInFrames={235}>
        <DiscoverScene />
      </Sequence>
      <Sequence from={390} durationInFrames={270}>
        <DetailScene />
      </Sequence>
      <Sequence from={660} durationInFrames={270}>
        <ApplyScene />
      </Sequence>
      <Sequence from={930} durationInFrames={445}>
        <ClosingScene />
      </Sequence>
      <Audio
        src={staticFile("generated/senior-club-promo/full-narration-human.wav")}
        volume={1}
      />
    </AbsoluteFill>
  );
}
