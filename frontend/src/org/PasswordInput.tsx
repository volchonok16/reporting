import { useState } from 'react'
import './password-input.css'

type PasswordInputProps = {
  value: string
  onChange: (value: string) => void
  autoComplete?: string
  required?: boolean
  placeholder?: string
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 5C7 5 2.73 8.11 1 12.5c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5C21.27 8.11 17 5 12 5Zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"
      />
    </svg>
  )
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M3.27 2.5 2 3.77l2.2 2.2A11.8 11.8 0 0 0 1 12.5C2.73 16.89 7 20 12 20c2.09 0 4.03-.53 5.74-1.46l2.49 2.49 1.27-1.27L3.27 2.5ZM7.53 9.8l1.55 1.55a2.5 2.5 0 0 0 3.32 3.32l1.55 1.55a5 5 0 0 1-6.42-6.42Zm4.47 6.2a5 5 0 0 1-5-5c0-.69.14-1.34.39-1.94l2.05 2.05c-.03.29-.04.59-.04.89a2.5 2.5 0 0 0 2.5 2.5c.3 0 .6-.01.89-.04l2.05 2.05c-.6.25-1.25.39-1.94.39Zm8.47-3.5c-.55 1.4-1.47 2.63-2.64 3.57l1.46 1.46A11.8 11.8 0 0 0 23 12.5c-1.73-4.39-6-7.5-11-7.5-1.06 0-2.08.14-3.04.4l1.67 1.67c.44-.08.9-.12 1.37-.12 3.59 0 6.73 2.08 8.47 5.05Z"
      />
    </svg>
  )
}

export default function PasswordInput({
  value,
  onChange,
  autoComplete,
  required,
  placeholder,
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="org-password-input">
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        required={required}
        placeholder={placeholder}
      />
      <button
        type="button"
        className="org-password-input-toggle"
        onClick={() => setVisible((current) => !current)}
        aria-label={visible ? 'Скрыть пароль' : 'Показать пароль'}
        aria-pressed={visible}
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  )
}
