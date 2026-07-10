type OrgFilterIconProps = {
  className?: string
}

export default function OrgFilterIcon({ className }: OrgFilterIconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M1.75 3.5a.75.75 0 0 1 .75-.75h11a.75.75 0 0 1 .53 1.28l-3.72 3.72v3.75a.75.75 0 0 1-.41.67l-2.25 1.13a.75.75 0 0 1-1.09-.67v-4.88L2.22 4.03a.75.75 0 0 1-.47-.53Z"
      />
    </svg>
  )
}
