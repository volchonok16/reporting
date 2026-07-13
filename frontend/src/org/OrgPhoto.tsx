import { useState } from 'react'
import { resolvePhotoUrl } from '../api'

type OrgPhotoProps = {
  url?: string | null
  name: string
  className?: string
  placeholderClassName?: string
}

function initialsFromName(name: string): string {
  return (
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '?'
  )
}

export default function OrgPhoto({ url, name, className, placeholderClassName }: OrgPhotoProps) {
  const [failed, setFailed] = useState(false)
  const src = resolvePhotoUrl(url)

  if (!src || failed) {
    return (
      <div className={placeholderClassName ?? className} aria-hidden="true">
        {initialsFromName(name)}
      </div>
    )
  }

  return (
    <img
      src={src}
      alt=""
      className={className}
      draggable={false}
      onDragStart={(event) => event.preventDefault()}
      onError={() => setFailed(true)}
    />
  )
}
