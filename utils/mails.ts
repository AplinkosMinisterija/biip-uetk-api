import { ServerClient } from 'postmark';
import { FormStatus, FormType } from '../services/forms.service';
import { RequestStatus } from '../services/requests.service';

let client: ServerClient;
if (process.env.POSTMARK_KEY) {
  client = new ServerClient(process.env.POSTMARK_KEY);
}

const sender = 'noreply@biip.lt';

export function emailCanBeSent() {
  if (!client) return false;

  return ['staging', 'production'].includes(process.env.NODE_ENV);
}

function hostUrl(isAdmin: boolean = false) {
  return isAdmin ? process.env.ADMIN_HOST : process.env.APP_HOST;
}

export function notifyOnFormUpdate(
  email: string,
  status: string,
  formId: number | string,
  formType: string,
  objectName: string,
  objectId: string,
  isAdmin: boolean = false
) {
  const updateTypes: any = {
    [FormStatus.APPROVED]: 'Patvirtintas',
    [FormStatus.REJECTED]: 'Atmestas',
    [FormStatus.SUBMITTED]: 'Pakartotinai pateiktas',
    [FormStatus.RETURNED]: 'Grąžintas taisymui',
  };

  const formTypeTranlates: any = {
    [FormType.NEW]: 'įregistravimo',
    [FormType.EDIT]: 'redagavimo',
    [FormType.REMOVE]: 'išregistravimo',
  };

  const updateType = updateTypes[status] || '';

  if (!updateType) return;

  const path = isAdmin ? 'uetk/teikimo-anketos' : 'duomenu-teikimas';

  if (objectId) {
    objectName = `${objectName}, ${objectId}`;
  }

  return client.sendEmailWithTemplate({
    From: sender,
    To: email.toLowerCase(),
    TemplateId: 32594846,
    TemplateModel: {
      title: updateType,
      titleText: updateType.toLowerCase(),
      typeText: formTypeTranlates[formType] || 'teikimo',
      objectName,
      actionUrl: `${hostUrl(isAdmin)}/${path}/${formId}`,
    },
  });
}

export function notifyOnRequestUpdate(
  email: string,
  status: string,
  requestId: number | string,
  isAdmin: boolean = false
) {
  const updateTypes: any = {
    [RequestStatus.APPROVED]: 'Patvirtintas',
    [RequestStatus.REJECTED]: 'Atmestas',
    [RequestStatus.SUBMITTED]: 'Pakartotinai pateiktas',
    [RequestStatus.RETURNED]: 'Grąžintas taisymui',
  };
  const updateType = updateTypes[status] || '';

  if (!updateType) return;

  const path = `${isAdmin ? 'uetk/' : ''}duomenu-gavimas`;

  return client.sendEmailWithTemplate({
    From: sender,
    To: email.toLowerCase(),
    TemplateId: 32594663,
    TemplateModel: {
      title: updateType,
      titleText: updateType.toLowerCase(),
      actionUrl: `${hostUrl(isAdmin)}/${path}/${requestId}`,
    },
  });
}

export function notifyOnFileGenerated(
  email: string,
  requestId: number | string,
  isAdmin: boolean = false
) {
  const path = `${isAdmin ? 'uetk/' : ''}duomenu-gavimas`;

  return client.sendEmailWithTemplate({
    From: sender,
    To: email.toLowerCase(),
    TemplateId: 32594847,
    TemplateModel: {
      requestId,
      actionUrl: `${hostUrl(isAdmin)}/${path}/${requestId}`,
    },
  });
}
