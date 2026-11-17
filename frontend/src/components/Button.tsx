import type { ComponentPropsWithRef } from 'react'

type ButtonBaseProps = ComponentPropsWithRef<'button'> & {
  size: 'sm' | 'md' | 'lg'
  variant?: 'default' | 'primary' | 'quiet' | 'danger'
  busy?: boolean
}

type ButtonProps =
  | (ButtonBaseProps & { iconOnly?: false | undefined })
  | (ButtonBaseProps & { iconOnly: true; 'aria-label': string })

export function Button({ busy, className, disabled, iconOnly, size, type = 'button', variant = 'default', ...props }: ButtonProps) {
  const classes = [
    'bp-button',
    `bp-button--${size}`,
    variant !== 'default' && `bp-button--${variant}`,
    iconOnly && 'bp-button--icon',
    className,
  ].filter(Boolean).join(' ')

  return <button {...props} className={classes} type={type} disabled={busy || disabled} data-busy={busy ? 'true' : undefined} aria-busy={busy ? 'true' : undefined} />
}
