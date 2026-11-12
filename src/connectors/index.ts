import { airtable } from './airtable'
import { asana } from './asana'
import { brevo } from './brevo'
import { clickup } from './clickup'
import { confluence } from './confluence'
import { docusign } from './docusign'
import { fireflies } from './fireflies'
import { gong } from './gong'
import { googleSheets } from './google-sheets'
import { hubspot } from './hubspot'
import { intercom } from './intercom'
import { jira } from './jira'
import { lemonsqueezy } from './lemonsqueezy'
import { linear } from './linear'
import { loopio } from './loopio'
import { monday } from './monday'
import { netsuite } from './netsuite'
import { notion } from './notion'
import { paddle } from './paddle'
import { pipedrive } from './pipedrive'
import { planhat } from './planhat'
import { posthog } from './posthog'
import { quickbooks } from './quickbooks'
import { salesforce } from './salesforce'
import { salesloft } from './salesloft'
import { semrush } from './semrush'
import { sensorTower } from './sensor-tower'
import { sentry } from './sentry'
import { servicenow } from './servicenow'
import { similarweb } from './similarweb'
import { stripe } from './stripe'
import { trello } from './trello'
import { trustpilot } from './trustpilot'
import { xero } from './xero'
import { youtrack } from './youtrack'
import { zendesk } from './zendesk'

import type { ConnectorDefinition } from '../types'

export { airtable, asana, brevo, clickup, confluence, docusign, fireflies, gong, googleSheets, hubspot, intercom, jira, lemonsqueezy, linear, loopio, monday, netsuite, notion, paddle, pipedrive, planhat, posthog, quickbooks, salesforce, salesloft, semrush, sensorTower, sentry, servicenow, similarweb, stripe, trello, trustpilot, xero, youtrack, zendesk }

/** Every built-in connector, in catalog order (by category: CRM and sales, billing, accounting, support, work, knowledge, data, analytics, market intelligence). */
export const builtinConnectors: ConnectorDefinition[] = [
  hubspot,
  salesforce,
  pipedrive,
  salesloft,
  stripe,
  paddle,
  lemonsqueezy,
  quickbooks,
  xero,
  netsuite,
  zendesk,
  intercom,
  servicenow,
  planhat,
  gong,
  fireflies,
  jira,
  linear,
  asana,
  clickup,
  monday,
  trello,
  youtrack,
  sentry,
  notion,
  confluence,
  googleSheets,
  airtable,
  docusign,
  loopio,
  posthog,
  brevo,
  sensorTower,
  similarweb,
  semrush,
  trustpilot
]
