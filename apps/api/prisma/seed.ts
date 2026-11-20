import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../generated/prisma/client';

const nodeEnvironment = process.env.NODE_ENV;
if (nodeEnvironment === 'production') {
  throw new Error('Database seeding is disabled in production.');
}
if (nodeEnvironment !== 'development' && nodeEnvironment !== 'test') {
  throw new Error('Database seeding is permitted only in development or test environments.');
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required to seed the database.');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

function futureDate(daysFromNow: number, hourUtc: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + daysFromNow);
  date.setUTCHours(hourUtc, 0, 0, 0);
  return date;
}

async function seed(): Promise<void> {
  const [admin, organizer, student, waitlistedStudent] = await Promise.all([
    prisma.user.upsert({
      where: { email: 'admin@example.edu' },
      update: { firstName: 'Avery', lastName: 'Administrator', role: 'ADMIN', isActive: true },
      create: {
        email: 'admin@example.edu',
        googleSubject: 'seed-google-subject-admin',
        firstName: 'Avery',
        lastName: 'Administrator',
        role: 'ADMIN',
      },
    }),
    prisma.user.upsert({
      where: { email: 'jordan.lee@example.edu' },
      update: { firstName: 'Jordan', lastName: 'Lee', role: 'ORGANIZER', isActive: true },
      create: {
        email: 'jordan.lee@example.edu',
        googleSubject: 'seed-google-subject-jordan-lee',
        firstName: 'Jordan',
        lastName: 'Lee',
        role: 'ORGANIZER',
      },
    }),
    prisma.user.upsert({
      where: { email: 'maya.chen@example.edu' },
      update: { firstName: 'Maya', lastName: 'Chen', role: 'STUDENT', isActive: true },
      create: {
        email: 'maya.chen@example.edu',
        googleSubject: 'seed-google-subject-maya-chen',
        firstName: 'Maya',
        lastName: 'Chen',
        role: 'STUDENT',
      },
    }),
    prisma.user.upsert({
      where: { email: 'noah.patel@example.edu' },
      update: { firstName: 'Noah', lastName: 'Patel', role: 'STUDENT', isActive: true },
      create: {
        email: 'noah.patel@example.edu',
        googleSubject: 'seed-google-subject-noah-patel',
        firstName: 'Noah',
        lastName: 'Patel',
        role: 'STUDENT',
      },
    }),
  ]);

  const clubSlug = 'campus-data-science-society';
  const existingClub = await prisma.club.findFirst({
    where: { slug: clubSlug, deletedAt: null },
    select: { id: true },
  });
  const clubData = {
    name: 'Campus Data Science Society',
    slug: clubSlug,
    description: 'Student-led talks and workshops on data.',
    createdById: organizer.id,
  } satisfies Prisma.ClubUncheckedCreateInput;
  const club = existingClub
    ? await prisma.club.update({ where: { id: existingClub.id }, data: clubData })
    : await prisma.club.create({ data: clubData });

  await Promise.all([
    prisma.clubMembership.upsert({
      where: { clubId_userId: { clubId: club.id, userId: organizer.id } },
      update: { role: 'PRESIDENT', status: 'ACTIVE', leftAt: null },
      create: {
        clubId: club.id,
        userId: organizer.id,
        role: 'PRESIDENT',
        status: 'ACTIVE',
        joinedAt: new Date(),
      },
    }),
    prisma.clubMembership.upsert({
      where: { clubId_userId: { clubId: club.id, userId: student.id } },
      update: { role: 'MEMBER', status: 'ACTIVE', leftAt: null },
      create: {
        clubId: club.id,
        userId: student.id,
        role: 'MEMBER',
        status: 'ACTIVE',
        joinedAt: new Date(),
      },
    }),
  ]);

  async function upsertActiveCategory(slug: string, name: string, description: string) {
    const existing = await prisma.eventCategory.findFirst({
      where: { slug, deletedAt: null },
      select: { id: true },
    });
    const data = { slug, name, description } satisfies Prisma.EventCategoryCreateInput;

    return existing
      ? prisma.eventCategory.update({ where: { id: existing.id }, data })
      : prisma.eventCategory.create({ data });
  }

  const [workshops, community] = await Promise.all([
    upsertActiveCategory('workshops', 'Workshops', 'Hands-on campus learning sessions.'),
    upsertActiveCategory('community', 'Community', 'Campus service and community events.'),
  ]);

  const venueSlug = 'north-hall-innovation-forum';
  const existingVenue = await prisma.venue.findFirst({
    where: { slug: venueSlug, deletedAt: null },
    select: { id: true },
  });
  const venueData = {
    name: 'Innovation Forum',
    slug: venueSlug,
    building: 'North Hall',
    room: 'Forum 201',
    capacity: 120,
    isAccessible: true,
  } satisfies Prisma.VenueCreateInput;
  const venue = existingVenue
    ? await prisma.venue.update({ where: { id: existingVenue.id }, data: venueData })
    : await prisma.venue.create({ data: venueData });

  const workshopStart = futureDate(8, 18);
  const workshopEnd = new Date(workshopStart.getTime() + 2 * 60 * 60 * 1000);
  const serviceStart = futureDate(16, 9);
  const serviceEnd = new Date(serviceStart.getTime() + 3 * 60 * 60 * 1000);

  const workshopSlug = 'campus-data-science-workshop';
  const existingWorkshop = await prisma.event.findFirst({
    where: { slug: workshopSlug, deletedAt: null },
    select: { id: true },
  });
  const workshopData = {
    title: 'Campus Data Science Workshop',
    slug: workshopSlug,
    description: 'A beginner-friendly evening workshop with practical data exercises.',
    status: 'APPROVED',
    startAt: workshopStart,
    endAt: workshopEnd,
    capacity: 120,
    clubId: club.id,
    categoryId: workshops.id,
    createdById: organizer.id,
    approvedById: admin.id,
    approvedAt: new Date(),
  } satisfies Prisma.EventUncheckedCreateInput;
  const workshop = existingWorkshop
    ? await prisma.event.update({ where: { id: existingWorkshop.id }, data: workshopData })
    : await prisma.event.create({ data: workshopData });

  const serviceDaySlug = 'campus-community-service-day';
  const existingServiceDay = await prisma.event.findFirst({
    where: { slug: serviceDaySlug, deletedAt: null },
    select: { id: true },
  });
  const serviceDayData = {
    title: 'Campus Community Service Day',
    slug: serviceDaySlug,
    description: 'A morning of campus and neighborhood volunteer activities.',
    status: 'PENDING_APPROVAL',
    startAt: serviceStart,
    endAt: serviceEnd,
    capacity: 80,
    clubId: club.id,
    categoryId: community.id,
    createdById: organizer.id,
    approvedById: null,
    approvedAt: null,
  } satisfies Prisma.EventUncheckedCreateInput;
  const serviceDay = existingServiceDay
    ? await prisma.event.update({ where: { id: existingServiceDay.id }, data: serviceDayData })
    : await prisma.event.create({ data: serviceDayData });

  await Promise.all([
    prisma.venueBooking.upsert({
      where: { id: '00000000-0000-4000-8000-000000000101' },
      update: {
        eventId: workshop.id,
        venueId: venue.id,
        requestedById: organizer.id,
        reviewedById: admin.id,
        status: 'APPROVED',
        startAt: workshopStart,
        endAt: workshopEnd,
        reviewedAt: new Date(),
      },
      create: {
        id: '00000000-0000-4000-8000-000000000101',
        eventId: workshop.id,
        venueId: venue.id,
        requestedById: organizer.id,
        reviewedById: admin.id,
        status: 'APPROVED',
        startAt: workshopStart,
        endAt: workshopEnd,
        reviewedAt: new Date(),
      },
    }),
    prisma.venueBooking.upsert({
      where: { id: '00000000-0000-4000-8000-000000000102' },
      update: {
        eventId: serviceDay.id,
        venueId: venue.id,
        requestedById: organizer.id,
        status: 'PENDING',
        startAt: serviceStart,
        endAt: serviceEnd,
        reviewedById: null,
        reviewedAt: null,
      },
      create: {
        id: '00000000-0000-4000-8000-000000000102',
        eventId: serviceDay.id,
        venueId: venue.id,
        requestedById: organizer.id,
        status: 'PENDING',
        startAt: serviceStart,
        endAt: serviceEnd,
      },
    }),
    prisma.rsvp.upsert({
      where: { eventId_userId: { eventId: workshop.id, userId: student.id } },
      update: { status: 'GOING', waitlistPosition: null },
      create: { eventId: workshop.id, userId: student.id, status: 'GOING' },
    }),
    prisma.rsvp.upsert({
      where: { eventId_userId: { eventId: workshop.id, userId: waitlistedStudent.id } },
      update: { status: 'WAITLISTED', waitlistPosition: 1 },
      create: {
        eventId: workshop.id,
        userId: waitlistedStudent.id,
        status: 'WAITLISTED',
        waitlistPosition: 1,
      },
    }),
  ]);

  const notificationDedupeKey = 'seed:rsvp-confirmed:maya-campus-data-science-workshop';
  const existingNotification = await prisma.notification.findFirst({
    where: { dedupeKey: notificationDedupeKey, deletedAt: null },
    select: { id: true },
  });
  const notificationData = {
    userId: student.id,
    eventId: workshop.id,
    dedupeKey: notificationDedupeKey,
    type: 'RSVP_CONFIRMED',
    title: 'RSVP confirmed',
    body: `Your place at ${workshop.title} is confirmed.`,
  } satisfies Prisma.NotificationUncheckedCreateInput;
  if (existingNotification) {
    await prisma.notification.update({
      where: { id: existingNotification.id },
      data: notificationData,
    });
  } else {
    await prisma.notification.create({ data: notificationData });
  }
}

async function main(): Promise<void> {
  try {
    await seed();
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const errorType = error instanceof Error ? error.name : 'UnknownError';
  console.error(`Database seed failed (${errorType}).`);
  process.exitCode = 1;
});
