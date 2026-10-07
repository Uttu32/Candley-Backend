import nodemailer, { type Transporter } from 'nodemailer'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'

let transporter: Transporter | undefined

const getTransporter = () => {
  if (!env.SMTP_HOST) return undefined
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  })
  return transporter
}

export const isMailConfigured = () => Boolean(env.SMTP_HOST)

type Mail = { to: string; subject: string; text: string; html?: string }

/** Test hook: when set, mail is captured here instead of being sent. */
export const mailOutbox: Mail[] | undefined = env.NODE_ENV === 'test' ? [] : undefined

/**
 * Sends an email. Returns true only when the SMTP server accepted the message.
 * Never throws: email is non-essential to the request that triggers it.
 */
export const sendMail = async (mail: Mail, attempts = 2): Promise<boolean> => {
  if (mailOutbox) {
    mailOutbox.push(mail)
    return true
  }
  const transport = getTransporter()
  if (!transport) {
    logger.warn({ subject: mail.subject }, 'Email not sent: SMTP is not configured')
    return false
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const info = await transport.sendMail({ from: env.MAIL_FROM, ...mail })
      if ((info.accepted?.length ?? 0) > 0) return true
      logger.warn({ subject: mail.subject, attempt }, 'Email rejected by SMTP server')
    } catch (error) {
      logger.warn({ subject: mail.subject, attempt, message: error instanceof Error ? error.message : String(error) }, 'Email delivery failed')
    }
  }
  return false
}

/** Fire-and-forget wrapper for notifications that must not block or fail the request. */
export const queueMail = (mail: Mail) => {
  void sendMail(mail)
}

const formatInr = (value: number) => `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

export const mailTemplates = {
  passwordReset: (name: string, link: string): Omit<Mail, 'to'> => ({
    subject: 'Reset your Candley Aroma password',
    text: `Hi ${name},\n\nUse this link to reset your password. It expires in 30 minutes:\n${link}\n\nIf you did not request this, you can ignore this email.`,
  }),
  orderConfirmed: (name: string, order: { orderNumber: string; total: number; paymentMethod: string }): Omit<Mail, 'to'> => ({
    subject: `Order ${order.orderNumber} confirmed`,
    text: `Hi ${name},\n\nThank you for your order ${order.orderNumber}.\nTotal: ${formatInr(order.total)}\nPayment: ${order.paymentMethod === 'COD' ? 'Cash on delivery' : 'Paid online'}\n\nWe'll let you know when it ships.`,
  }),
  orderStatus: (name: string, orderNumber: string, status: string): Omit<Mail, 'to'> => ({
    subject: `Order ${orderNumber}: ${status.replaceAll('_', ' ').toLowerCase()}`,
    text: `Hi ${name},\n\nYour order ${orderNumber} is now ${status.replaceAll('_', ' ').toLowerCase()}.`,
  }),
  paymentFailed: (name: string, orderNumber: string): Omit<Mail, 'to'> => ({
    subject: `Payment failed for order ${orderNumber}`,
    text: `Hi ${name},\n\nWe could not confirm payment for order ${orderNumber}. No money has been captured for this attempt. You can try again from your account.`,
  }),
}
