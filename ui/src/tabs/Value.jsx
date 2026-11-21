// Value: what Infoblox and Bloxsmith gave this customer in the last 30 days,
// on one screen for a manager. Security, then the platform, then the work
// Bloxsmith did. It only reads. ?variant=a, b or c opens a preview look;
// without one this is the page as it has always been.
import { CardGrid, TabIntro } from '../components/ui.jsx'
import ValueSecurity from './value/ValueSecurity.jsx'
import ValuePlatform from './value/ValuePlatform.jsx'
import ValueWork from './value/ValueWork.jsx'
import ValueLooks, { useVariant } from './value/ValueLooks.jsx'

export default function Value() {
  const variant = useVariant()
  if (variant) return <ValueLooks variant={variant} />
  return (
    <div className="w-full px-6 py-5">
      <h1 className="text-copy font-semibold tracking-tight mb-1">Value</h1>
      <TabIntro>What Infoblox and Bloxsmith did for you in the last 30 days. This page only reads.</TabIntro>
      <CardGrid layoutKey="value">
        <ValueSecurity key="value-security" panelId="value-security" />
        <ValuePlatform key="value-platform" panelId="value-platform" />
        <ValueWork key="value-work" panelId="value-work" />
      </CardGrid>
    </div>
  )
}
