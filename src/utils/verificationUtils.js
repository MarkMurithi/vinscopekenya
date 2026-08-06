export function generateVerificationCode(length = 6) {
  const digits = Array.from({ length }, () => Math.floor(Math.random() * 10));
  return digits.join('');
}

export function maskContact(contact = '', type = 'email') {
  if (!contact) return '';

  if (type === 'sms') {
    if (contact.length <= 4) return contact;
    return `${contact.slice(0, 4)}*****`;
  }

  const [local, domain] = String(contact).split('@');
  if (!domain) return `${local.slice(0, 1)}***`;
  return `${local.slice(0, 1)}***@${domain}`;
}
