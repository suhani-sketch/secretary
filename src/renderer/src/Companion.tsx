/**
 * Phase 1 placeholder companion: a static layered SVG that only breathes, plus a tiny
 * expression change per state. The real state machine and room arrive in Phase 6.
 */
export type CompanionState = 'idle' | 'thinking' | 'working' | 'waiting'

export function Companion({ state }: { state: CompanionState }): React.JSX.Element {
  const eyesClosed = state === 'waiting'
  const tilt = state === 'thinking' ? -6 : 0
  return (
    <div className="relative w-full flex justify-center">
      <style>{`
        @keyframes breathe { 0%,100% { transform: translateY(0) scale(1); } 50% { transform: translateY(-3px) scale(1.015); } }
        @keyframes blink { 0%, 92%, 100% { transform: scaleY(1); } 95% { transform: scaleY(0.1); } }
        .companion-body { animation: breathe 4.5s ease-in-out infinite; transform-origin: 50% 100%; }
        .companion-eye { animation: blink 6s ease-in-out infinite; transform-origin: center; }
      `}</style>
      <svg viewBox="0 0 200 200" className="w-44 h-44" aria-hidden>
        {/* floor shadow */}
        <ellipse cx="100" cy="182" rx="52" ry="8" fill="#3A2E28" opacity="0.08" />
        <g className="companion-body" style={{ transform: `rotate(${tilt}deg)`, transformOrigin: '100px 180px' }}>
          {/* body */}
          <path
            d="M100 40 C 140 40, 160 80, 160 120 C 160 160, 135 178, 100 178 C 65 178, 40 160, 40 120 C 40 80, 60 40, 100 40 Z"
            fill="#B5836D"
          />
          <path
            d="M100 60 C 128 60, 142 92, 142 122 C 142 152, 124 166, 100 166 C 76 166, 58 152, 58 122 C 58 92, 72 60, 100 60 Z"
            fill="#D9B79F"
            opacity="0.7"
          />
          {/* ears */}
          <ellipse cx="66" cy="52" rx="12" ry="18" fill="#B5836D" transform="rotate(-20 66 52)" />
          <ellipse cx="134" cy="52" rx="12" ry="18" fill="#B5836D" transform="rotate(20 134 52)" />
          {/* eyes */}
          {eyesClosed ? (
            <>
              <path d="M78 110 q8 5 16 0" stroke="#3A2E28" strokeWidth="3" fill="none" strokeLinecap="round" />
              <path d="M106 110 q8 5 16 0" stroke="#3A2E28" strokeWidth="3" fill="none" strokeLinecap="round" />
            </>
          ) : (
            <>
              <circle className="companion-eye" cx="86" cy="108" r="5" fill="#3A2E28" />
              <circle className="companion-eye" cx="114" cy="108" r="5" fill="#3A2E28" />
            </>
          )}
          {/* mouth */}
          {state === 'working' ? (
            <ellipse cx="100" cy="128" rx="5" ry="4" fill="#3A2E28" opacity="0.8" />
          ) : (
            <path d="M92 126 q8 7 16 0" stroke="#3A2E28" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          )}
          {/* cheeks */}
          <circle cx="74" cy="122" r="5" fill="#E9A48E" opacity="0.5" />
          <circle cx="126" cy="122" r="5" fill="#E9A48E" opacity="0.5" />
        </g>
        {state === 'thinking' && (
          <g fill="#3A2E28" opacity="0.5">
            <circle cx="150" cy="38" r="3" />
            <circle cx="160" cy="28" r="4" />
            <circle cx="172" cy="16" r="5" />
          </g>
        )}
      </svg>
    </div>
  )
}
