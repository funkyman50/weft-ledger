import { useEffect, useState, type RefObject } from 'react'
import { X } from 'lucide-react'

import { Button } from '../../components/Button'
import startingBalanceImage from './assets/initialization/v2-01-starting-balance.png'
import alreadyIncludedImage from './assets/initialization/v2-02-already-included.png'
import suggestedSelectionsImage from './assets/initialization/v2-03-suggested-selections.png'
import manuallyClearedImage from './assets/initialization/v2-04-manually-cleared.png'

interface InitializationOnboardingProps {
  accountName: string
  headingId: string
  headingRef: RefObject<HTMLHeadingElement | null>
  replay: boolean
  onDismiss: () => void
  onClose: () => void
}

const cards = [
  {
    title: 'Your history needs a starting point.',
    image: startingBalanceImage,
    alt: 'Earlier account history fades into a Starting Balance marker at the beginning of imported transactions. A bank tile reports a current balance of $1,000.',
    body: 'Plaid might not send every transaction since you opened your account.',
    takeaway: 'Weft adds a ⚓ Starting Balance transaction at the top of each new account so its cleared balance matches the Current Balance your bank reports.',
  },
  {
    title: 'Pending transactions may already be counted.',
    image: alreadyIncludedImage,
    alt: 'Bank reports $1,000. A dashed enclosure surrounds that balance and pending deposits of +$50 and +$75. The pending −$20 purchase is aligned below, outside the enclosure.',
    body: 'Some banks include transactions in their Current Balance while they still show as Pending. This happens most often when credit cards apply payments immediately.',
    takeaway: 'Weft needs to know which transactions your bank already includes so they aren’t counted twice.',
  },
  {
    title: 'We’ll help you sort it out.',
    image: suggestedSelectionsImage,
    alt: 'The bank reports $1,000. The +$50 and +$75 pending rows are checked as Suggested and enclosed with the bank balance. The −$20 pending row is unchecked outside the enclosure.',
    body: 'Enter the Current Balance shown in your online banking. Weft may suggest pending transactions your bank appears to have already included.',
    takeaway: 'You can review and adjust the choices before saving.',
  },
  {
    title: 'Cleared here. Still pending at your bank.',
    image: manuallyClearedImage,
    alt: 'The same +$50 transaction is Pending with an amber dot at your bank, and Cleared with a green dot and red asterisk in your register.',
    body: 'Manually clear pending Plaid transactions in the ledger to align Weft’s cleared balance with the Current Balance your bank reports.',
    takeaway: 'Your bank still shows them as Pending until they post.',
  },
]

export function InitializationOnboarding({ accountName, headingId, headingRef, replay, onDismiss, onClose }: InitializationOnboardingProps) {
  const [index, setIndex] = useState(0)
  const card = cards[index]
  const isLast = index === cards.length - 1

  useEffect(() => { headingRef.current?.focus() }, [headingRef, index])

  return <div className="bp-onboarding">
    <div className="bp-onboarding-top">
      <div><span>A clear starting point</span><small>{accountName}</small></div>
      <div>
        <Button size="lg" variant="quiet" onClick={onDismiss}>Skip intro</Button>
        <Button size="lg" variant="quiet" iconOnly aria-label={replay ? 'Back to setup' : 'Close'} onClick={onClose}><X aria-hidden="true" /></Button>
      </div>
    </div>
    <div className="bp-onboarding-body">
      <div className="bp-onboarding-art"><img src={card.image} alt={card.alt} /></div>
      <div className="bp-onboarding-copy">
        <h2 id={headingId} ref={headingRef} tabIndex={-1}>{card.title}</h2>
        <p>{card.body}</p>
        <p className="bp-onboarding-takeaway">{card.takeaway}</p>
      </div>
      {index === 2 && <div className="bp-onboarding-balance-example" aria-label="Illustrative working balance after account setup">
        <p className="bp-onboarding-balance-label">Weft working balance</p>
        <div className="bp-onboarding-balance-comparison">
          <div className="is-without"><strong>$1,105</strong><span>Without this adjustment</span></div>
          <span className="bp-onboarding-result-arrow" aria-hidden="true">→</span>
          <div><strong>$980</strong><span>After setup</span></div>
        </div>
        <p className="bp-onboarding-balance-reason">$1,000 already counted − $20 still pending = $980</p>
      </div>}
    </div>
    <div className="bp-onboarding-footer">
      {index > 0 ? <Button size="lg" variant="quiet" onClick={() => setIndex((current) => current - 1)}>Back</Button> : <span aria-hidden="true" />}
      <div className="bp-onboarding-progress" aria-hidden="true">{cards.map((item, itemIndex) => <span className={itemIndex === index ? 'is-active' : ''} key={item.title} />)}</div>
      <p className="bp-visually-hidden" aria-live="polite">Step {index + 1} of {cards.length}</p>
      <Button size="lg" variant="primary" onClick={() => isLast ? onDismiss() : setIndex((current) => current + 1)}>{isLast ? (replay ? 'Back to setup' : 'Review my balance') : 'Next'}</Button>
    </div>
  </div>
}
