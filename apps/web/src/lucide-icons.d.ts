declare module 'lucide-react/dist/esm/icons/*.mjs' {
  import type { ComponentType, SVGProps } from 'react'

  type LucideIconProps = SVGProps<SVGSVGElement> & {
    size?: number | string
    strokeWidth?: number | string
  }

  const Icon: ComponentType<LucideIconProps>
  export default Icon
}
