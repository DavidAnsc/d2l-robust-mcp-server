import { displayTimeZone } from '../config.js';

// Utility functions for marshalling D2L API responses to LLM-friendly formats

// Strip HTML tags and decode entities
export function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A readable date with its time zone named, e.g. "Mon, Nov 24, 2025, 5:00 PM GMT".
 * Shown in D2L_TIMEZONE if set, else the machine's zone. The zone is always printed,
 * because on a server the machine's zone is often UTC rather than the student's.
 */
export function formatDate(isoDate: string | null | undefined, timeZone: string | undefined = displayTimeZone()): string | null {
  if (!isoDate) return null;
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  });
}

/** Days since 1970 for the calendar date `date` falls on in `timeZone`. */
function calendarDay(date: Date, timeZone: string | undefined): number {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day')) / 86_400_000;
}

/**
 * "today", "tomorrow", "in 3 days", "2 days ago", … by calendar day in the display zone,
 * so something due at 23:59 tonight is "today" whatever the time now. Beyond a week,
 * the full date.
 */
export function formatRelativeDate(
  isoDate: string | null | undefined,
  now: Date = new Date(),
  timeZone: string | undefined = displayTimeZone()
): string | null {
  if (!isoDate) return null;
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return null;
  const diffDays = calendarDay(date, timeZone) - calendarDay(now, timeZone);

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'tomorrow';
  if (diffDays === -1) return 'yesterday';
  if (diffDays > 0 && diffDays <= 7) return `in ${diffDays} days`;
  if (diffDays < 0 && diffDays >= -7) return `${Math.abs(diffDays)} days ago`;

  return formatDate(isoDate, timeZone);
}

// Format file size
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Remove null, undefined, empty strings, and empty arrays from object
export function removeEmpty<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    result[key as keyof T] = value as T[keyof T];
  }
  return result;
}

// ============= FILES =============
/** A file as Brightspace lists it on announcements, assignments, submissions and feedback. */
export interface RawFile {
  FileId?: number;
  FileName: string;
  Size: number;
}

export interface MarshalledFile {
  /** Pass to read_file to get the file's contents. */
  fileId?: number;
  name: string;
  size: string;
}

export function marshalFiles(files: RawFile[] | null | undefined): MarshalledFile[] | undefined {
  if (!files?.length) return undefined;
  return files.map((f) => removeEmpty({ fileId: f.FileId, name: f.FileName, size: formatFileSize(f.Size) }) as MarshalledFile);
}

// ============= GRADES =============
export interface RawGrade {
  PointsNumerator: number | null;
  PointsDenominator: number | null;
  GradeObjectName: string;
  DisplayedGrade: string | null;
  Comments?: { Text: string; Html: string };
  LastModified: string | null;
}

export interface MarshalledGrade {
  name: string;
  score: string | null;
  percentage: string | null;
  feedback: string | null;
  lastModified: string | null;
}

export function marshalGrades(grades: RawGrade[]): MarshalledGrade[] {
  return grades.map((g) => removeEmpty({
    name: g.GradeObjectName,
    score: g.PointsNumerator !== null && g.PointsDenominator !== null
      ? `${g.PointsNumerator}/${g.PointsDenominator}`
      : null,
    percentage: g.DisplayedGrade?.trim() || null,
    feedback: g.Comments?.Text?.trim() || null,
    lastModified: formatDate(g.LastModified),
  })) as MarshalledGrade[];
}

// ============= ANNOUNCEMENTS =============
export interface RawAnnouncement {
  Id: number;
  Title: string;
  Body: { Text: string; Html: string };
  CreatedDate: string;
  StartDate: string | null;
  Attachments: RawFile[];
  IsPublished: boolean;
}

export interface MarshalledAnnouncement {
  id: number;
  title: string;
  body: string;
  date: string | null;
  attachments?: MarshalledFile[];
}

export function marshalAnnouncements(announcements: RawAnnouncement[]): MarshalledAnnouncement[] {
  return announcements.map((a) => removeEmpty({
    id: a.Id,
    title: a.Title,
    body: stripHtml(a.Body.Text || a.Body.Html),
    date: formatDate(a.CreatedDate),
    attachments: marshalFiles(a.Attachments),
  })) as MarshalledAnnouncement[];
}

// ============= CALENDAR / DUE DATES =============
export interface RawCalendarEvent {
  CalendarEventId: number;
  Title: string;
  Description: string;
  StartDateTime: string;
  EndDateTime: string;
  CalendarEventViewUrl: string;
  OrgUnitName: string;
  AssociatedEntity?: {
    AssociatedEntityType: string;
    AssociatedEntityId: number;
    Link: string;
  };
}

export interface MarshalledDueDate {
  title: string;
  dueDate: string | null;
  dueDateRelative: string | null;
  course: string;
  type: string | null;
  assignmentId: number | null;
  viewUrl: string;
  submitUrl: string | null;
}

export function marshalCalendarEvents(response: { Objects: RawCalendarEvent[] }): MarshalledDueDate[] {
  return response.Objects.map((e) => {
    const entityType = e.AssociatedEntity?.AssociatedEntityType;
    let type: string | null = null;
    if (entityType?.includes('Dropbox')) type = 'assignment';
    else if (entityType?.includes('Quiz')) type = 'quiz';
    else if (entityType?.includes('Discussion')) type = 'discussion';
    else if (entityType) type = entityType.split('.').pop() || null;

    return removeEmpty({
      title: e.Title,
      dueDate: formatDate(e.StartDateTime),
      dueDateRelative: formatRelativeDate(e.StartDateTime),
      course: e.OrgUnitName,
      type,
      assignmentId: e.AssociatedEntity?.AssociatedEntityId || null,
      viewUrl: e.CalendarEventViewUrl,
      submitUrl: e.AssociatedEntity?.Link || null,
    });
  }) as MarshalledDueDate[];
}

// ============= COURSES / ENROLLMENTS =============
export interface RawEnrollment {
  OrgUnit: {
    Id: number;
    Type: { Code: string; Name: string };
    Name: string;
    Code: string;
    HomeUrl: string;
  };
  Access: {
    IsActive: boolean;
    CanAccess: boolean;
    LastAccessed: string | null;
  };
}

export interface MarshalledCourse {
  id: number;
  name: string;
  code: string;
  type: string;
  homeUrl: string;
  isActive: boolean;
  canAccess: boolean;
  lastAccessed: string | null;
}

export function marshalEnrollments(response: { Items: RawEnrollment[] }): MarshalledCourse[] {
  return response.Items
    .filter((e) => e.OrgUnit.Type.Code === 'Course Offering')
    .map((e) => removeEmpty({
      id: e.OrgUnit.Id,
      name: e.OrgUnit.Name,
      code: e.OrgUnit.Code,
      type: e.OrgUnit.Type.Name,
      homeUrl: e.OrgUnit.HomeUrl,
      isActive: e.Access.IsActive,
      canAccess: e.Access.CanAccess,
      lastAccessed: formatDate(e.Access.LastAccessed),
    })) as MarshalledCourse[];
}

// ============= ASSIGNMENTS =============
export interface RawAssignment {
  Id: number;
  Name: string;
  DueDate: string | null;
  CustomInstructions: { Text: string; Html: string };
  Assessment: { ScoreDenominator: number };
  Attachments: RawFile[];
  LinkAttachments: Array<{ Name: string; Url: string }>;
  AllowableFileType: number;
  CustomAllowableFileTypes: string[] | null;
}

export interface MarshalledAssignment {
  id: number;
  name: string;
  dueDate: string | null;
  dueDateRelative: string | null;
  points: number;
  instructions: string | null;
  attachments?: MarshalledFile[];
  links?: Array<{ name: string; url: string }>;
  allowedFileTypes: string | null;
}

export function marshalAssignments(assignments: RawAssignment[]): MarshalledAssignment[] {
  return assignments.map((a) => marshalAssignment(a));
}

export function marshalAssignment(a: RawAssignment): MarshalledAssignment {
  let fileTypes: string | null = null;
  if (a.AllowableFileType === 0) fileTypes = 'any';
  else if (a.AllowableFileType === 5 && a.CustomAllowableFileTypes?.length) {
    fileTypes = a.CustomAllowableFileTypes.join(', ');
  }

  return removeEmpty({
    id: a.Id,
    name: a.Name,
    dueDate: formatDate(a.DueDate),
    dueDateRelative: formatRelativeDate(a.DueDate),
    points: a.Assessment?.ScoreDenominator ?? 0,
    instructions: stripHtml(a.CustomInstructions?.Text || a.CustomInstructions?.Html) || null,
    attachments: marshalFiles(a.Attachments),
    links: a.LinkAttachments?.length > 0
      ? a.LinkAttachments.map((l) => ({ name: l.Name, url: l.Url }))
      : undefined,
    allowedFileTypes: fileTypes,
  }) as MarshalledAssignment;
}

// ============= SUBMISSIONS =============
export interface RawSubmission {
  Entity: {
    DisplayName: string;
    EntityId?: number;
    EntityType?: string;
  };
  Status: number;
  Feedback: {
    Score: number | null;
    Feedback: { Text: string; Html: string } | null;
    Files?: RawFile[];
  } | null;
  Submissions: Array<{
    Id: number;
    SubmissionDate: string;
    Comment: { Text: string } | null;
    Files: RawFile[];
  }>;
  CompletionDate: string | null;
}

export interface MarshalledAttempt {
  /** Pass to read_file, with a file's fileId, to read what you submitted. */
  submissionId: number;
  submissionDate: string | null;
  files: MarshalledFile[];
  comment?: string;
}

export interface MarshalledSubmission {
  submitted: boolean;
  submittedBy: string;
  /** "user" or "group": needed, with entityId, to read feedback files. */
  entityType?: string;
  entityId?: number;
  /** Latest attempt (top-level fields kept for a quick answer). */
  submissionId?: number;
  submissionDate: string | null;
  submissionDateRelative: string | null;
  files: MarshalledFile[];
  comment: string | null;
  grade: number | null;
  feedback: string | null;
  /** Files the instructor attached to the feedback (read with read_file + feedbackFileId). */
  feedbackFiles?: MarshalledFile[];
  /** Earlier attempts, newest first, when there was more than one. */
  earlierAttempts?: MarshalledAttempt[];
}

export function marshalSubmissions(submissions: RawSubmission[]): MarshalledSubmission[] {
  return submissions.map((s) => {
    // Newest first; don't rely on the API's order.
    const attempts = [...(s.Submissions ?? [])].sort(
      (a, b) => new Date(b.SubmissionDate).getTime() - new Date(a.SubmissionDate).getTime()
    );
    const latest = attempts[0];
    return removeEmpty({
      submitted: s.Status === 1 || attempts.length > 0,
      submittedBy: s.Entity.DisplayName,
      entityType: s.Entity.EntityType?.toLowerCase(),
      entityId: s.Entity.EntityId,
      submissionId: latest?.Id,
      submissionDate: formatDate(latest?.SubmissionDate),
      submissionDateRelative: formatRelativeDate(latest?.SubmissionDate),
      files: marshalFiles(latest?.Files) ?? [],
      comment: latest?.Comment?.Text?.trim() || null,
      grade: s.Feedback?.Score ?? null,
      feedback: stripHtml(s.Feedback?.Feedback?.Text || s.Feedback?.Feedback?.Html) || null,
      feedbackFiles: marshalFiles(s.Feedback?.Files),
      earlierAttempts: attempts.length > 1
        ? attempts.slice(1).map((a) => removeEmpty({
            submissionId: a.Id,
            submissionDate: formatDate(a.SubmissionDate),
            files: marshalFiles(a.Files) ?? [],
            comment: a.Comment?.Text?.trim() || undefined,
          }) as MarshalledAttempt)
        : undefined,
    });
  }) as MarshalledSubmission[];
}

// ============= COURSE CONTENT =============
export interface RawContentModule {
  ModuleId: number;
  Title: string;
  Description?: { Text: string; Html: string };
  Topics?: RawContentTopic[];
  Modules?: RawContentModule[];
}

export interface RawContentTopic {
  TopicId: number;
  Title: string;
  Url?: string;
  TypeIdentifier?: string;
}

export interface MarshalledModule {
  id: number;
  title: string;
  description: string | null;
  topics?: MarshalledTopic[];
  modules?: MarshalledModule[];
}

export interface MarshalledTopic {
  id: number;
  title: string;
  url: string | null;
  type: string | null;
}

export function marshalContentModules(modules: RawContentModule[]): MarshalledModule[] {
  return modules.map((m) => marshalContentModule(m));
}

export function marshalContentModule(m: RawContentModule): MarshalledModule {
  return removeEmpty({
    id: m.ModuleId,
    title: m.Title,
    description: stripHtml(m.Description?.Text || m.Description?.Html) || null,
    topics: m.Topics?.map((t) => removeEmpty({
      id: t.TopicId,
      title: t.Title,
      url: t.Url || null,
      type: t.TypeIdentifier || null,
    })) as MarshalledTopic[] | undefined,
    modules: m.Modules?.length ? marshalContentModules(m.Modules) : undefined,
  }) as MarshalledModule;
}

// For TOC which has a different structure
export interface RawTocModule {
  ModuleId: number;
  Title: string;
  Description?: { Text: string; Html: string };
  Topics?: RawContentTopic[];
  Modules?: RawTocModule[];
}

export function marshalToc(toc: { Modules: RawTocModule[] }): MarshalledModule[] {
  return marshalContentModules(toc.Modules || []);
}

export interface RawTopic {
  TopicId: number;
  Title: string;
  Description?: { Text: string; Html: string };
  Url?: string;
  TypeIdentifier?: string;
  /** 1 = file, 3 = link. */
  TopicType?: number;
  IsBroken?: boolean;
}

export interface MarshalledTopicDetail {
  id: number;
  title: string;
  description: string | null;
  url: string | null;
  type: string | null;
}

export function marshalTopic(t: RawTopic): MarshalledTopicDetail {
  return removeEmpty({
    id: t.TopicId,
    title: t.Title,
    description: stripHtml(t.Description?.Text || t.Description?.Html) || null,
    url: t.Url || null,
    type: t.TypeIdentifier || null,
  }) as MarshalledTopicDetail;
}
