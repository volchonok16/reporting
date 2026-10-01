"use client";

type VoiceBrandLogoProps = {
  variant?: "mark" | "full";
  height?: number;
  className?: string;
};

function voiceAsset(path: string): string {
  const base = (process.env.NEXT_PUBLIC_VOICE_BASE_PATH || "").replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** T2 Бизнес logo — те же ассеты, что в reporting BrandLogo. */
export default function VoiceBrandLogo({
  variant = "mark",
  height = 36,
  className = "",
}: VoiceBrandLogoProps) {
  if (variant === "full") {
    const width = Math.round(height * (920 / 276));
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className={`brand-logo brand-logo-full brand-logo-full--light${className ? ` ${className}` : ""}`}
          src={voiceAsset("/brand/T2_B2B_Logo_black.svg")}
          alt="T2 Бизнес"
          height={height}
          width={width}
          decoding="async"
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className={`brand-logo brand-logo-full brand-logo-full--dark${className ? ` ${className}` : ""}`}
          src={voiceAsset("/brand/T2_B2B_Logo_white.svg")}
          alt="T2 Бизнес"
          height={height}
          width={width}
          decoding="async"
        />
      </>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={`brand-logo brand-logo-mark${className ? ` ${className}` : ""}`}
      src={voiceAsset("/brand/T2_B2B_Avatar.svg")}
      alt="T2 Бизнес"
      height={height}
      width={height}
      decoding="async"
    />
  );
}
