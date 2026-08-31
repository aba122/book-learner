import type { HTMLAttributes } from 'react'

export default function Card({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-l border border-line bg-paper-2 shadow-card ${className}`}
      {...rest}
    />
  )
}
