import type { HTMLAttributes } from 'react'

export default function Card({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-l border border-sep bg-card shadow-card ${className}`}
      {...rest}
    />
  )
}
